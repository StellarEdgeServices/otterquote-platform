#!/usr/bin/env python3
"""gh-2442: concurrency proof for request_dunning_retry(), for a THROWAWAY Postgres only.

NEVER point this at production or any Supabase project. It starts its own scratch server (pip packages
`pgserver` and `psycopg2-binary`), loads supabase/tests/gh2442_replica_fixture.sql and the forward migration,
and commits rows there. It is not run by CI. Adapted from the independent reviewer's harness for PR #2579
(comment 6047683096).

Usage:  python3 supabase/tests/gh2442_concurrency_harness.py <repo-root> <scratch-data-dir>

What it shows (D-379: at most 3 retry requests per failed payment):
  CONC-1  row at count 2; caller A holds its transaction open; caller B is seen waiting on the row lock; A commits;
          B answers already_requested; final count 3.
  NEG     the same function with `FOR UPDATE OF pf` removed: the second caller no longer sees the first one's request
          and tries to write a 4th; the CHECK on retry_request_count rejects it (23514) and the count stays 3. With
          the CHECK also removed both answer requested and the count reaches 4. That is the failure the lock
          prevents first and the CHECK prevents second.
  CONC-2  24 simultaneous callers, 6 rounds, the 15-minute window aged out between rounds: exactly 1 requested per
          round for 3 rounds, then 24 of 24 not_retryable; the count never passes 3.
  CONC-3  a REPEATABLE READ caller holding a stale snapshot gets 40001 and writes nothing.
"""
import json, re, shutil, sys, threading, time
import pgserver, psycopg2

root, datadir = sys.argv[1], sys.argv[2]
shutil.rmtree(datadir, ignore_errors=True)
srv = pgserver.get_server(datadir, cleanup_mode='stop')
uri = srv.get_uri()


def conn(auto=True):
    c = psycopg2.connect(uri)
    c.autocommit = auto
    return c


def rd(p):
    return open(root + '/supabase/' + p).read()


a = conn()
cur = a.cursor()
cur.execute('select version()')
print('PG', cur.fetchone()[0][:16])
cur.execute(rd('tests/gh2442_replica_fixture.sql'))
fwd = rd('migrations_drafts/gh2442_dunning_retry_request.sql')
cur.execute(fwd)
cur.execute('select id, user_id from contractors order by id limit 1')
k1, u1 = cur.fetchone()
CLAIMS = json.dumps({'sub': u1, 'role': 'authenticated'})


def mk(count, age_min):
    cur.execute("insert into payment_failures(contractor_id, amount_cents, dunning_status) values (%s, 5000, 'active') returning id", (k1,))
    f = cur.fetchone()[0]
    cur.execute("update payment_failures set retry_request_count=%s, retry_requested_at=now() - make_interval(mins => %s) where id=%s", (count, age_min, f))
    return f


def count_of(f):
    cur.execute('select retry_request_count from payment_failures where id=%s', (f,))
    return cur.fetchone()[0]


def call(c, fn, f):
    k = c.cursor()
    k.execute("select set_config('request.jwt.claims', %s, true)", (CLAIMS,))
    k.execute('set local role authenticated')
    k.execute('select public.%s(%%s)' % fn, (f,))
    return k.fetchone()[0]


def run_block(fn, tag):
    f = mk(2, 16)
    A, B, out = conn(False), conn(False), {}
    out['A'] = call(A, fn, f)['status']

    def b():
        try:
            out['B'] = call(B, fn, f)['status']
            B.commit()
        except Exception as e:
            out['B'] = 'REJECTED %s' % e.pgcode
            B.rollback()
    t = threading.Thread(target=b)
    t.start()
    time.sleep(1.0)
    cur.execute("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like %s", ('%' + fn + '%',))
    blocked = cur.fetchone()[0]
    A.commit()
    t.join()
    print('%s start count=2, A holds its transaction open; B waiting on a lock=%d; A=%s B=%s; final count=%d'
          % (tag, blocked, out['A'], out['B'], count_of(f)))
    A.close()
    B.close()


run_block('request_dunning_retry', '[CONC-1]')
body = re.search(r'CREATE OR REPLACE FUNCTION public.*?\$fn\$;', fwd, re.S).group(0)
nolock = body.replace('request_dunning_retry', 'rdr_nolock').replace('FOR UPDATE OF pf', '')
assert 'FOR UPDATE' not in nolock
cur.execute(nolock)
run_block('rdr_nolock', '[NEG no row lock, CHECK present]')
cur.execute('alter table payment_failures drop constraint payment_failures_retry_request_count_check')
run_block('rdr_nolock', '[NEG no row lock, CHECK removed]')
cur.execute('delete from payment_failures')
cur.execute('alter table payment_failures add constraint payment_failures_retry_request_count_check check (retry_request_count between 0 and 3)')
cur.execute('drop function public.rdr_nolock(uuid)')

f = mk(0, 16)
for i in range(6):
    res, lk, bar = [], threading.Lock(), threading.Barrier(24)

    def w():
        c = conn(False)
        bar.wait()
        try:
            r = call(c, 'request_dunning_retry', f)['status']
            c.commit()
        except Exception as e:
            r = 'REJECTED %s' % e.pgcode
            c.rollback()
        c.close()
        with lk:
            res.append(r)
    ts = [threading.Thread(target=w) for _ in range(24)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    print('[CONC-2] round %d (24 simultaneous) %s count=%d' % (i + 1, {k: res.count(k) for k in sorted(set(res))}, count_of(f)))
    cur.execute("update payment_failures set retry_requested_at = retry_requested_at - interval '16 minutes' where id=%s", (f,))

f = mk(2, 16)
A, B = conn(False), conn(False)
B.set_session(isolation_level='REPEATABLE READ')
B.cursor().execute('select 1')
call(A, 'request_dunning_retry', f)
A.commit()
try:
    rr = call(B, 'request_dunning_retry', f)['status']
except Exception as e:
    rr = 'REJECTED %s' % e.pgcode
B.rollback()
print('[CONC-3] REPEATABLE READ caller with a stale snapshot: %s; final count=%d' % (rr, count_of(f)))
a.close()
srv.cleanup()

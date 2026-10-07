#!/usr/bin/env python3
"""gh-2442: concurrency proof for request_dunning_retry(), for a THROWAWAY Postgres only.

NEVER point this at production or any Supabase project. It starts its own scratch server (pip packages
`pgserver` and `psycopg2-binary`), loads supabase/tests/gh2442_replica_fixture.sql and the forward migration,
and commits rows there. It is not run by CI. Adapted from the independent reviewer's harness for PR #2579
(comment 6047683096).

Usage:  python3 supabase/tests/gh2442_concurrency_harness.py <repo-root> <scratch-data-dir> [<other-forward.sql>]
        The optional third argument is a different forward file to load as a NEGATIVE CONTROL (for example the
        per-row version at commit 0e0d255); the same tests then show what it gets wrong.

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
  TWO ROWS OF ONE QUOTE (on main one failed charge leaves a webhook row and a scheduled row for the same quote):
  CONC-4  the quote holds 2 requests (1 on each row); caller A asks on the webhook row and holds its transaction
          open; caller B asks on the scheduled row and is seen waiting on a lock; A commits; B answers
          already_requested; the quote total is 3.
  NEG     the same with the row locks removed: both answer requested and the quote total is 4. The CHECK does not
          stop this (each row is still within 0..3): the per-quote cap is the function's lock and sum, not the CHECK.
  CONC-5  24 simultaneous callers, 12 on each row, 6 rounds, window aged out between rounds: exactly 1 requested
          per round for 3 rounds, then 24 of 24 not_retryable; the quote total never passes 3; no deadlock (40P01).
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
fwd = open(sys.argv[3]).read() if len(sys.argv) > 3 else rd('migrations_drafts/gh2442_dunning_retry_request.sql')
if len(sys.argv) > 3:
    print('NEGATIVE CONTROL: forward file is', sys.argv[3].split('/')[-2] + '/' + sys.argv[3].split('/')[-1])
cur.execute(fwd)
cur.execute('select id, user_id from contractors order by id limit 1')
k1, u1 = cur.fetchone()
CLAIMS = json.dumps({'sub': u1, 'role': 'authenticated'})


cur.execute('select id from quotes where contractor_id=%s order by id limit 1', (k1,))
q1 = cur.fetchone()[0]


def mk(count, age_min, quote=None, scheduled=True):
    # scheduled=True: the row process-dunning:1083 writes (schedule set). False: the webhook row (no schedule).
    cur.execute("insert into payment_failures(quote_id, contractor_id, amount_cents, dunning_status, homeowner_notify_at) "
                "values (%s, %s, 5000, 'active', case when %s then now() + interval '1 day' end) returning id", (quote, k1, scheduled))
    f = cur.fetchone()[0]
    cur.execute("update payment_failures set retry_request_count=%s, retry_requested_at=now() - make_interval(mins => %s) where id=%s", (count, age_min, f))
    return f


def count_of(f):
    cur.execute('select retry_request_count from payment_failures where id=%s', (f,))
    return cur.fetchone()[0]


def quote_total():
    cur.execute('select coalesce(sum(retry_request_count), 0) from payment_failures where quote_id=%s', (q1,))
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
nolock = body.replace('request_dunning_retry', 'rdr_nolock').replace('FOR UPDATE OF pf', '')  # the lock, wherever it is taken
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


# ---- two rows of one quote ----
def pair(count_each):
    cur.execute('delete from payment_failures where quote_id=%s', (q1,))
    w_row = mk(count_each, 16, quote=q1, scheduled=False)
    s_row = mk(count_each, 16, quote=q1, scheduled=True)
    return w_row, s_row


def run_pair(fn, tag):
    w_row, s_row = pair(1)
    A, B, out = conn(False), conn(False), {}
    out['A'] = call(A, fn, w_row)['status']

    def b():
        try:
            out['B'] = call(B, fn, s_row)['status']
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
    print('%s quote holds 2 (1 on each row); A on the webhook row holds its transaction open; B on the scheduled row waiting on a lock=%d; A=%s B=%s; quote total=%d'
          % (tag, blocked, out['A'], out['B'], quote_total()))
    A.close()
    B.close()


run_pair('request_dunning_retry', '[CONC-4]')
cur.execute(nolock)
run_pair('rdr_nolock', '[NEG two rows, no row locks, CHECK present]')
cur.execute('drop function public.rdr_nolock(uuid)')

w_row, s_row = pair(0)
cur.execute('update payment_failures set retry_requested_at=null where quote_id=%s', (q1,))
for i in range(6):
    res, lk, bar = [], threading.Lock(), threading.Barrier(24)

    def w2(f):
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
    ts = [threading.Thread(target=w2, args=(w_row if n % 2 else s_row,)) for n in range(24)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    print('[CONC-5] round %d (24 simultaneous, 12 on each row of one quote) %s quote total=%d' % (i + 1, {k: res.count(k) for k in sorted(set(res))}, quote_total()))
    cur.execute("update payment_failures set retry_requested_at = retry_requested_at - interval '16 minutes' where quote_id=%s", (q1,))
a.close()
srv.cleanup()

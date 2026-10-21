#!/usr/bin/env python3
"""gh-2875 (#2939 REVIEW 6279629536): two-session race checks for contractor_sms_numbers. THROWAWAY Postgres only.
Usage: python3 gh2875_d391_contractor_sms_numbers_race.py "<libpq dsn of a db that has the forward applied>"
R1 write skew: T2 disables Y (open), T1 removes X (the primary); both commit. PASS = the contractor still has >= 1 verified number.
R2 concurrent opt-out: T2 opts out Y (open), T1 opts out X (primary); both commit. PASS = exactly one primary, and it is Z.
Prints `R1 PASS|FAIL ...` and `R2 PASS|FAIL ...`. Exit 0 always (the runner judges the lines)."""
import sys, threading, time, uuid
import psycopg2

DSN = sys.argv[1]
V = "v-race"

def conn():
    c = psycopg2.connect(DSN); c.autocommit = False; return c

def setup(c, contractor, rows):
    cur = c.cursor()
    cur.execute("INSERT INTO public.sms_disclosure_versions (id, program_name, disclosure_text) VALUES (%s,'TEST','TEST TEXT') ON CONFLICT DO NOTHING", (V,))
    for nid, phone, primary, age_days in rows:
        cur.execute("""INSERT INTO public.contractor_sms_numbers (id, contractor_id, user_id, phone_e164, is_primary, verified_at,
                       last_confirmed_at, disclosure_version_id, disclosure_text, verification_method, source)
                       VALUES (%s,%s,%s,%s,%s, now() - make_interval(days => %s), now() - interval '1 day', %s,'TEST TEXT','sms_otp','settings')""",
                    (nid, contractor, contractor, phone, primary, age_days, V))
    c.commit()

def race(stmt_t2, stmt_t1):
    t2, t1 = conn(), conn()
    t2.cursor().execute(stmt_t2)              # T2 holds its change open
    out = {}
    def run_t1():
        try:
            t1.cursor().execute(stmt_t1); t1.commit(); out["t1"] = "committed"
        except psycopg2.Error as e:
            t1.rollback(); out["t1"] = "refused " + (e.pgcode or "?")
    th = threading.Thread(target=run_t1); th.start()
    time.sleep(1.5)
    out["t1_blocked"] = th.is_alive()
    t2.commit(); th.join(30)
    t1.close(); t2.close()
    return out

admin = conn()
# R1
c1 = str(uuid.uuid4()); x1, y1 = str(uuid.uuid4()), str(uuid.uuid4())
setup(admin, c1, [(x1, "+15551000001", True, 100), (y1, "+15551000002", False, 50)])
r = race(f"UPDATE public.contractor_sms_numbers SET status='disabled' WHERE id='{y1}'",
         f"UPDATE public.contractor_sms_numbers SET status='removed' WHERE id='{x1}'")
cur = admin.cursor()
cur.execute("SELECT count(*) FROM public.contractor_sms_numbers WHERE contractor_id=%s AND status='verified'", (c1,)); n = cur.fetchone()[0]
admin.commit()
print(f"R1 {'PASS' if n >= 1 else 'FAIL'} verified_left={n} t1={r['t1']} t1_blocked={r['t1_blocked']}")
# R2
c2 = str(uuid.uuid4()); x2, y2, z2 = (str(uuid.uuid4()) for _ in range(3))
setup(admin, c2, [(x2, "+15552000001", True, 300), (y2, "+15552000002", False, 200), (z2, "+15552000003", False, 100)])
optout = "UPDATE public.contractor_sms_numbers SET status='opted_out', opted_out_at=now(), opt_out_keyword='STOP', opt_out_channel='sms_keyword' WHERE id='{}'"
r = race(optout.format(y2), optout.format(x2))
cur.execute("SELECT coalesce(string_agg(phone_e164, ','), '') FROM public.contractor_sms_numbers WHERE contractor_id=%s AND is_primary", (c2,)); prim = cur.fetchone()[0]
admin.commit()
print(f"R2 {'PASS' if prim == '+15552000003' else 'FAIL'} primary={prim or '<none>'} t1={r['t1']} t1_blocked={r['t1_blocked']}")

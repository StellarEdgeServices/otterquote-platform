#!/usr/bin/env python3
"""gh-2931 -- build and run the proof for gh2931_bidder_summary_no_filename on a throwaway Postgres (pgserver).

  python3 supabase/tests/gh2931_bidder_summary_no_filename_proof_run.py            run everything below on a private server
  python3 supabase/tests/gh2931_bidder_summary_no_filename_proof_run.py --emit F   write the production proof (markers filled) to F and stop

The throwaway database gets the columns of claims/contractors/quotes/profiles/carrier_profiles that the view reads, with the production
types, then the APPLIED view (supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql, verbatim). Checks:
  1. the applied view re-created here has the same pg_get_viewdef md5 as production (c8ad94c4...), so the 'before' is the live text;
  2. the built proof (live -> forward -> rollback) reports every read and the structure AS EXPECTED;
  3. the forward file alone, then the rollback file alone, committed: columns 39 then 40, md5 b0689f5f then c8ad94c4;
  4. the forward file refuses (P0A31, nothing changed) when the view is not the expected definition;
  5. NEGATIVE CONTROL: the proof with a forward that does nothing reports UNEXPECTED (reads would still show the filename);
  6. NEGATIVE CONTROL: the proof template run unbuilt prints the live matrix only.
Exit 0 only if all hold. pgserver / psycopg2 absent: exit 1 (set GH2931_ALLOW_SKIP=1 to skip).
"""
import os, re, sys, tempfile, hashlib

try:
    import pgserver, psycopg2
except ImportError as e:  # pragma: no cover
    print("gh2931 proof: pgserver / psycopg2 not installed (%s)" % e)
    sys.exit(0 if os.environ.get("GH2931_ALLOW_SKIP") else 1)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf-8").read()
APPLIED = "supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql"
FWD = "supabase/migrations_drafts/gh2931_bidder_summary_no_filename.sql"
RB = "supabase/migrations_drafts/gh2931_bidder_summary_no_filename_rollback.sql"
PROOF = "supabase/tests/gh2931_bidder_summary_no_filename_proof.sql"
LIVE_MD5, NEW_MD5 = "c8ad94c45c52b5468ddf7c4979a2607c", "7b0f2430b1cb7482ac34af28e17553db"


def body(sql):
    return re.sub(r"^\s*(BEGIN|COMMIT);\s*$", "", sql, flags=re.M)


def quote(tag, sql):
    assert "$" + tag + "$" not in sql
    return "$%s$\n%s\n$%s$" % (tag, body(sql), tag)


def build(fwd_sql, rb_sql):
    t = rd(PROOF)
    t = t.replace("/*@F@*/ NULL /*@F@*/", quote("fwd", fwd_sql)).replace("/*@R@*/ NULL /*@R@*/", quote("rb", rb_sql))
    return t


if "--emit" in sys.argv:
    out = sys.argv[sys.argv.index("--emit") + 1]
    open(out, "w", encoding="utf-8").write(build(rd(FWD), rd(RB)))
    print("wrote", out)
    sys.exit(0)

SCHEMA = """
do $$ declare r text; begin foreach r in array array['authenticated','anon','service_role'] loop
  if not exists (select 1 from pg_roles where rolname = r) then execute 'create role ' || r || ' nologin'; end if; end loop; end $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
grant usage on schema auth, public to authenticated, anon, service_role;
create table public.contractors(id uuid primary key, user_id uuid, created_at timestamptz, trades text[], status text, is_test boolean);
create table public.carrier_profiles(id uuid primary key, carrier_name text, created_at timestamptz);
create table public.profiles(id uuid primary key, full_name text, created_at timestamptz, is_test boolean);
create table public.quotes(id uuid primary key default gen_random_uuid(), claim_id uuid, contractor_id uuid, status text, created_at timestamptz, is_test boolean);
create table public.claims(id uuid primary key, user_id uuid, claim_number text, status text, created_at timestamptz, carrier_id uuid, material_category text, shingle_type text, impact_class text, designer_product text, designer_manufacturer text, has_estimate boolean, has_measurements boolean, ready_for_bids boolean, selected_contractor_id uuid, deductible_amount numeric(10,2), estimate_filename text, platform_fee_charged boolean, measurements_filename text, damage_type text, job_type text, rcv_amount numeric(10,2), acv_amount numeric(10,2), roof_squares numeric(6,1), repair_squares numeric(6,1), existing_shingle_brand text, existing_shingle_color text, urgency text, urgency_deadline date, homeowner_notes text, funding_type text, trades text[], homeowner_name text, property_address text, parsed_line_items jsonb, contractor_scope_summary text, siding_bid_released_at timestamptz, roofing_bid_released_at timestamptz, gutters_bid_released_at timestamptz, windows_bid_released_at timestamptz, bid_window_expires_at timestamptz, is_test boolean, carrier_name text, hover_measurements jsonb, measurement_shape text, property_city text, property_zip text);
"""
U = lambda i: "00000000-0000-4000-8000-0000000000%02d" % i
KS, KSU, KQ, KQU, CS, CQ, O1, O2 = [U(i) for i in range(1, 9)]
FIX = """
insert into contractors values ('%s','%s',now(),null,'active',true),('%s','%s',now(),null,'active',true);
insert into claims(id,user_id,status,ready_for_bids,is_test,selected_contractor_id,created_at) values
 ('%s','%s','contract_signed',true,true,'%s',now()), ('%s','%s','bidding',true,true,null,now());
insert into quotes(claim_id,contractor_id,status) values ('%s','%s','selected'),('%s','%s','submitted');
""" % (KS, KSU, KQ, KQU, CS, O1, KS, CQ, O2, CS, KS, CQ, KQ)

fails = []
def check(ok, msg):
    print(("PASS  " if ok else "FAIL  ") + msg)
    if not ok: fails.append(msg)

def fresh():
    d = tempfile.mkdtemp(prefix="gh2931pg")
    srv = pgserver.get_server(d, cleanup_mode="delete")
    c = psycopg2.connect(srv.get_uri()); c.autocommit = True
    cur = c.cursor(); cur.execute(SCHEMA); cur.execute(body(rd(APPLIED))); cur.execute(FIX)
    return srv, c, cur

def md5def(cur):
    cur.execute("select pg_get_viewdef('public.bidder_claim_summary'::regclass, true)"); return hashlib.md5(cur.fetchone()[0].encode()).hexdigest()
def ncols(cur):
    cur.execute("select count(*) from pg_attribute where attrelid='public.bidder_claim_summary'::regclass and attnum>0 and not attisdropped"); return cur.fetchone()[0]
def run_proof(cur, sql):
    try:
        cur.execute(sql); return "NO EXCEPTION (proof must always raise)"
    except psycopg2.Error as e:
        cur.connection.rollback() if not cur.connection.autocommit else None
        try: cur.execute("rollback")
        except Exception: pass
        return str(e)

srv, c, cur = fresh()
try:
    check(md5def(cur) == LIVE_MD5, "1. the applied view re-created here has the production definition md5 %s (got %s)" % (LIVE_MD5[:8], md5def(cur)[:8]))
    built = build(rd(FWD), rd(RB))
    txt = run_proof(cur, built)
    print(txt)
    check("VERDICT reads=AS EXPECTED ; structure=AS EXPECTED" in txt and "MISMATCH" not in txt and "== after rollback ==" in txt,
          "2. built proof: live, after forward, after rollback all AS EXPECTED")
    check(md5def(cur) == LIVE_MD5 and ncols(cur) == 40, "2b. the proof rolled everything back (view is still the live text)")
    cur.execute("select estimate_filename is not null from claims where id=%s", (CS,)); check(cur.fetchone()[0] is False, "2c. fixture write rolled back")
    # 3. forward alone, committed, then rollback alone
    cur.execute(rd(FWD))
    check(ncols(cur) == 40 and md5def(cur) == NEW_MD5, "3a. forward committed: still 40 columns, md5 %s" % NEW_MD5[:8])
    cur.execute("select attname from pg_attribute where attrelid='public.bidder_claim_summary'::regclass and attnum>0 and not attisdropped order by attnum")
    names = [r[0] for r in cur.fetchall()]
    check(names[38] == "estimate_filename" and names[32] == "has_estimate" and names[-1] == "measurements_filename", "3b. column set and order unchanged (estimate_filename 39, has_estimate 33)")
    cur.execute(rd(RB))
    check(ncols(cur) == 40 and md5def(cur) == LIVE_MD5, "3c. rollback committed: 40 columns, md5 %s" % LIVE_MD5[:8])
    # 4. forward refuses on a different definition
    cur.execute("drop view public.bidder_claim_summary"); cur.execute(body(rd(APPLIED)).replace("(c.estimate_filename IS NOT NULL OR coalesce(c.has_estimate, false))", "(c.estimate_filename IS NOT NULL)"))
    try:
        cur.execute(rd(FWD)); refused = False; msg = ""
    except psycopg2.Error as e:
        refused = True; msg = str(e)
    try: cur.execute("rollback")
    except Exception: pass
    check(refused and "not the expected definition" in msg, "4. forward refuses on a drifted definition and changes nothing (%s)" % msg.splitlines()[0][:80])
    check(ncols(cur) == 40, "4b. still 40 columns after the refusal")
    # 5. negative control: forward that does nothing
    cur.execute("drop view public.bidder_claim_summary"); cur.execute(body(rd(APPLIED)))
    noop = "BEGIN;\nSELECT 1;\nCOMMIT;"
    txt2 = run_proof(cur, build(noop, noop))
    check("UNEXPECTED" in txt2, "5. negative control: a forward that leaves the pre-fee path readable is reported UNEXPECTED")
    # 6. unbuilt template prints live only
    txt3 = run_proof(cur, rd(PROOF))
    print(txt3)
    check("VERDICT reads=AS EXPECTED ; structure=AS EXPECTED (live only" in txt3 and "S1  selected contractor, fee not charged: estimate_filename IS NOT NULL : 1" in txt3 and "Q1  bidder, fee not charged: estimate_filename IS NOT NULL : 0" in txt3,
          "6. unbuilt proof = the negative control: the selected contractor reads the path before the fee today, a bidder reads NULL")
finally:
    try: c.close()
    except Exception: pass
    try: srv.cleanup()
    except Exception: pass

print("\nGH2931_PROOF: " + ("ALL PASS" if not fails else "FAILED %d" % len(fails)))
sys.exit(1 if fails else 0)

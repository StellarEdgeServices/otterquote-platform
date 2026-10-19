#!/usr/bin/env python3
"""gh-2559 (Ben 6029315131 A / B.4) -- BEHAVIOURAL test of the bid-open guard on a throwaway Postgres.

supabase/migrations_drafts/gh2559_claims_bid_open_guard.sql is run VERBATIM on a private server (pgserver) with a stub
public.claims / public.profiles / auth.uid(). Every case runs as the named role inside its own transaction that is rolled back.
Phase BEFORE = the stub schema as it is today (no trigger): the forbidden cases must be ACCEPTED (negative control).
Phase AFTER  = the forward file applied: the forbidden cases must be REFUSED (SQLSTATE 23514, [gh2559-bid-open ...]),
the legitimate cases ACCEPTED. Exit 1 on any unexpected result. With GH2559_ALLOW_SKIP=1 a missing pgserver exits 0.

Run:  pip install pgserver psycopg2-binary && python3 tools/gh2559-bid-open-guard-behaviour.py
"""
import os, re, sys, tempfile, json

try:
    import pgserver, psycopg2
except ImportError as e:  # pragma: no cover
    print("gh2559 bid-open behaviour test: pgserver / psycopg2 not installed (%s)" % e)
    sys.exit(0 if os.environ.get("GH2559_ALLOW_SKIP") else 1)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FWD = os.path.join(ROOT, "supabase", "migrations_drafts", "gh2559_claims_bid_open_guard.sql")
RB = os.path.join(ROOT, "supabase", "migrations_drafts", "gh2559_claims_bid_open_guard_rollback.sql")
U = lambda i: "00000000-0000-4000-8000-0000000000%02d" % i
OWNER = U(1)

STUB = """
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'draft', ready_for_bids boolean,
  homeowner_name text, claim_number text, property_address text, estimate_filename text, has_estimate boolean,
  loss_sheet_parsed_at timestamptz, parsed_line_items jsonb, contractor_scope_summary text, notes text);
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT ALL ON public.claims, public.profiles TO authenticated, service_role;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON public.claims FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
"""

GOOD = {"sections": [{"name": "Roof", "items": [{"desc": "Remove shingles", "qty": 31.5, "unit_price": 98.25}]}],
        "summary": {"rcv": 12345.67, "deductible": 2500}}
def good(**kw):
    d = json.loads(json.dumps(GOOD)); d.update(kw); return d
def with_item(text):
    d = good(); d["sections"][0]["items"].append({"desc": text, "qty": 1}); return d

NAME, STREET = "Zelda Quixote", "4417 Larkspur Hollow Rd"
ADDR = STREET + ", Carmel, IN 46032"
PARSED_AT = "now()"

# (label, expect_after 'ACCEPT'/'REFUSE', claim fixture dict, preopen?, role, sql-set dict)
# Opening cases update an unopened claim to ready_for_bids = true with `set`.
OPEN = []
def op(label, expect, set_=None, claim=None, role="authenticated"):
    OPEN.append((label, expect, dict(claim or {}), dict(set_ or {}), role))

base = dict(estimate_filename="u/c/estimate.pdf", loss_sheet_parsed_at="now()", parsed_line_items=good())
op("O1 no estimate file, nothing parsed", "ACCEPT", claim=dict())
op("O2 estimate attached, never parsed (submit within a minute of upload)", "REFUSE", claim=dict(estimate_filename="u/c/e.pdf"))
op("O2b same, as service_role", "REFUSE", claim=dict(estimate_filename="u/c/e.pdf"), role="service_role")
op("O3a parsed_at set, parsed object {}", "REFUSE", claim=dict(estimate_filename="x", loss_sheet_parsed_at="now()", parsed_line_items={}))
op("O3b parsed object is an error marker", "REFUSE", claim=dict(estimate_filename="x", loss_sheet_parsed_at="now()", parsed_line_items={"error": "unreadable"}))
op("O3c sections [] and no rcv", "REFUSE", claim=dict(estimate_filename="x", loss_sheet_parsed_at="now()", parsed_line_items={"sections": [], "summary": {}}))
op("O3d summary present but parsed_at NULL", "REFUSE", claim=dict(estimate_filename="x", parsed_line_items=good()))
op("O4a read: sections", "ACCEPT", claim=base)
op("O4b read: rcv only", "ACCEPT", claim=dict(estimate_filename="x", loss_sheet_parsed_at="now()", parsed_line_items={"summary": {"rcv": 9000}}))
op("O5 has_estimate true, no file name, unparsed", "REFUSE", claim=dict(has_estimate=True))
op("O6 closed claim, unrelated update only (trigger does not fire)", "ACCEPT", claim=dict(estimate_filename="x"), set_=dict(ready_for_bids=False, notes="hi"))
# identity at opening (owner name from profiles.full_name; homeowner_name empty)
def idc(items=None, **kw):
    c = dict(base); c["property_address"] = ADDR
    if items is not None: c["parsed_line_items"] = items
    c.update(kw); return c
op("I0 clean summary (control)", "ACCEPT", claim=idc())
op("I1 name from profiles.full_name in a line item", "REFUSE", claim=idc(with_item("Insured: Zelda Quixote")))
op("I2a 'Last, First M.'", "REFUSE", claim=idc(with_item("QUIXOTE, Zelda M.")))
op("I2b double space and newline split", "REFUSE", claim=idc(with_item("zelda  \n quixote")))
op("I2c name only in contractor_scope_summary", "REFUSE", claim=idc(contractor_scope_summary="Prepared for Zelda Quixote, roof only"))
op("I2d homeowner_name column (not the profile)", "REFUSE", claim=idc(with_item("Inez Marlowe"), homeowner_name="Inez Marlowe"))
op("I3a name 'Tom Hail' vs 'hail damage' (legit)", "ACCEPT", claim=idc(with_item("hail damage, parking pad"), homeowner_name="Tom Hail"))
op("I3b name 'Park Ridge' vs 'ridge cap' (legit)", "ACCEPT", claim=idc(with_item("ridge cap and then park side"), homeowner_name="Park Ridge"))
op("I4a street as typed", "REFUSE", claim=idc(with_item("Location: 4417 Larkspur Hollow Rd")))
op("I4b street spelled Court, extra space", "REFUSE", claim=idc(with_item("4417  LARKSPUR HOLLOW Court")))
op("I4c address with no comma", "REFUSE", claim=idc(with_item("4417 Larkspur"), property_address="4417 Larkspur Hollow Rd Carmel IN 46032"))
op("I5 street name without a house number (legit)", "ACCEPT", claim=idc(with_item("Ridge Cap Rd"), property_address="Ridge Cap Rd, Carmel, IN"))
op("I5b address word alone, no number in summary (legit)", "ACCEPT", claim=idc(with_item("Larkspur is a shrub")))
op("I6a claim number with dashes vs spaces", "REFUSE", claim=idc(with_item("Claim CLM 250077"), claim_number="CLM-2500-77"))
op("I6b claim number as a bare JSON number", "REFUSE", claim=idc(with_item("x") | {"summary": {"rcv": 9000, "claim": 9876543}} if False else {**with_item("x"), "summary": {"rcv": 9000, "claim": 9876543}}), )
OPEN[-1] = ("I6b claim number as a bare JSON number", "REFUSE", {**idc({**with_item("x"), "summary": {"rcv": 9000, "claim": 9876543}}), "claim_number": "9876543"}, {}, "authenticated")
op("I6c claim number '1234' vs RCV 12345.67 (legit)", "ACCEPT", claim=idc(claim_number="1234"))
op("I6d claim number '2500' vs deductible 2500 (legit)", "ACCEPT", claim=idc(claim_number="2500"))
op("I6e claim number 'Roof' / 'none' (legit)", "ACCEPT", claim=idc(with_item("roof"), claim_number="Roof"))
op("I6f 7-digit claim number equal to a price (legit: quantity 98.25 != it)", "ACCEPT", claim=idc(claim_number="9825000"))

# already-open claims (summary written / identity edited afterwards)
def opened(**kw):
    c = dict(base); c.update(property_address=ADDR, ready_for_bids=True); c.update(kw); return c
LATER = [
    ("W1 open claim: parse writes a summary with the owner name (client)", "REFUSE", opened(), dict(parsed_line_items=with_item("Zelda Quixote")), "authenticated"),
    ("W1b same, as service_role (parse-loss-sheet)", "REFUSE", opened(), dict(parsed_line_items=with_item("Zelda Quixote")), "service_role"),
    ("W2 open claim: scope summary gets the street", "REFUSE", opened(), dict(contractor_scope_summary="at 4417 Larkspur Hollow"), "authenticated"),
    ("W3 open claim: owner edits address to match the summary", "REFUSE", opened(parsed_line_items=with_item("see 55 Elmwood Ln")), dict(property_address="55 Elmwood Ln, Carmel"), "authenticated"),
    ("W4 open claim: clean summary rewrite (legit)", "ACCEPT", opened(), dict(parsed_line_items=with_item("clean")), "service_role"),
    ("W5 open claim: unrelated column (legit)", "ACCEPT", opened(), dict(notes="hello"), "authenticated"),
    ("W6 open grandfathered claim with an unparsed estimate: ready flag re-sent (legit)", "ACCEPT", opened(loss_sheet_parsed_at=None, parsed_line_items=None), dict(ready_for_bids=True), "authenticated"),
    ("W7 open claim: unparsed estimate attached later (NOT refused: Q2)", "ACCEPT", opened(estimate_filename=None, loss_sheet_parsed_at=None, parsed_line_items=None), dict(estimate_filename="u/c/new.pdf"), "authenticated"),
]

def lit(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (dict, list)): return "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
    if v == "now()": return "now()"
    return "'" + str(v).replace("'", "''") + "'"

def run(conn, claim, preopen, setd, role):
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        cur.execute("SET LOCAL session_replication_role = replica")
        cur.execute("INSERT INTO public.profiles(id, full_name) VALUES (%s, %s)", (OWNER, NAME))
        cols = dict(claim); cols["user_id"] = OWNER
        cols.setdefault("ready_for_bids", False if not preopen else True)
        names = ",".join(cols); vals = ",".join(lit(v) for v in cols.values())
        cur.execute("INSERT INTO public.claims(%s) VALUES (%s) RETURNING id" % (names, vals))
        cid = cur.fetchone()[0]
        cur.execute("SET LOCAL session_replication_role = origin")
        if not preopen: setd = {"ready_for_bids": True, **setd}
        cur.execute("SET LOCAL ROLE %s" % role)
        cur.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (OWNER,))
        sets = ",".join("%s = %s" % (k, lit(v)) for k, v in setd.items())
        cur.execute("UPDATE public.claims SET %s WHERE id = '%s'" % (sets, cid))
        n = cur.rowcount
        return "ACCEPT" if n == 1 else "NOROW"
    except psycopg2.Error as e:
        m = (e.pgerror or "")
        return "REFUSE" if (e.pgcode == "23514" and "gh2559-bid-open" in m) else "ERR " + str(e.pgcode) + " " + m[:120]
    finally:
        cur.execute("ROLLBACK")

def phase(conn, name, expect_fn):
    bad = 0
    cases = [(l, e, c, False, s, r) for (l, e, c, s, r) in OPEN] + [(l, e, c, True, s, r) for (l, e, c, s, r) in LATER]
    for label, exp, claim, preopen, setd, role in cases:
        got = run(conn, claim, preopen, setd, role)
        want = expect_fn(exp)
        flag = "ok " if got == want else "BAD"
        if got != want: bad += 1
        print("%s [%-6s] %-70s want %-6s got %s" % (flag, name, label, want, got))
    return bad

def main():
    d = tempfile.mkdtemp(prefix="gh2559-bid-open-")
    pg = pgserver.get_server(d, cleanup_mode="delete")
    uri = pg.get_uri()
    conn = psycopg2.connect(uri); conn.autocommit = True
    cur = conn.cursor(); cur.execute(STUB)
    bad = 0
    # BEFORE: today's schema. Every REFUSE case is a defect, so it must be ACCEPTED here.
    print("== BEFORE (no guard): the forbidden cases are ACCEPTED (negative control)")
    bad += phase(conn, "BEFORE", lambda e: "ACCEPT")
    cur.execute(open(FWD).read())
    print("== AFTER forward file")
    bad += phase(conn, "AFTER", lambda e: e)
    # metadata
    cur.execute("SELECT count(*) FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname='claims_guard_bid_open' AND NOT tgisinternal"); t = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM pg_proc WHERE proname IN ('claims_guard_bid_open','gh2559_summary_identity_hit','gh2559_estimate_is_read')"); f = cur.fetchone()[0]
    cur.execute("SELECT has_function_privilege('authenticated','public.claims_guard_bid_open()','EXECUTE') OR has_function_privilege('anon','public.gh2559_estimate_is_read(jsonb,timestamptz)','EXECUTE')"); px = cur.fetchone()[0]
    print("trigger=%s functions=%s client_execute=%s" % (t, f, px))
    if (t, f, px) != (1, 3, False): bad += 1; print("BAD metadata")
    cur.execute(open(FWD).read())  # idempotent re-run
    cur.execute(open(RB).read())
    cur.execute("SELECT count(*) FROM pg_proc WHERE proname IN ('claims_guard_bid_open','gh2559_summary_identity_hit','gh2559_estimate_is_read')"); left = cur.fetchone()[0]
    print("after rollback: functions left=%s" % left)
    if left: bad += 1
    print("== AFTER rollback (guard gone)")
    bad += phase(conn, "ROLLBK", lambda e: "ACCEPT")
    print("RESULT: %s (%d unexpected)" % ("PASS" if bad == 0 else "FAIL", bad))
    sys.exit(1 if bad else 0)

main()

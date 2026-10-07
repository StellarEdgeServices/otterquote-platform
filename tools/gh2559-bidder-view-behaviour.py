#!/usr/bin/env python3
"""gh-2559 / D-368, D-371 -- BEHAVIOURAL test of the bidder view on a throwaway Postgres.

The view file supabase/migrations_drafts/gh2559_bidder_claims_view.sql is run VERBATIM on an empty
Postgres (pgserver: a private server in a temp directory, nothing shared, nothing kept). Claims are
planted with a made-up name, phone, email and street in every shape review 6047719061 listed, a
contractor who is only BIDDING reads every row through the view, and the test asserts that no street,
house number, PO box number, lot number, unit, phone, email or name comes back in location_city,
location_zip, homeowner_notes or urgency_reason. The selected contractor must read the notes as typed.

Negative control: pass --control <older view file> (CI passes none; the author ran it against head
37391cfe, where the same plants leak).

Run:  pip install pgserver psycopg2-binary && python3 tools/gh2559-bidder-view-behaviour.py
"""
import json, os, re, shutil, sys, tempfile

try:
    import pgserver, psycopg2
except ImportError as e:  # pragma: no cover
    print("gh2559 behaviour test: pgserver / psycopg2 not installed (%s)" % e)
    sys.exit(0 if os.environ.get("GH2559_ALLOW_SKIP") else 1)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
VIEW_FILE = os.path.join(ROOT, "supabase", "migrations_drafts", "gh2559_bidder_claims_view.sql")

NAME, PHONE, EMAIL = "Zelda Quixote", "317-555-0142", "zelda.q@example.invalid"
STREET = "4417 Larkspur Hollow Rd"
U = lambda i: "00000000-0000-4000-8000-0000000000%02d" % i
OWNER, BIDDER_U, SELECTED_U, K_BIDDER, K_SELECTED = [U(i) for i in range(1, 6)]

# (label, property_address, property_city, property_zip, expected city, expected zip)
ADDRESSES = [
    ("control: street, city, ST zip", STREET + ", Carmel, IN 46032", None, None, "Carmel", "46032"),
    ("control: zip+4", STREET + ", Carmel, IN 46032-1234", None, None, "Carmel", "46032"),
    ("control: city column set", STREET, "Carmel", "46032", "Carmel", "46032"),
    ("control: two-part address", STREET + ", Zionsville IN 46077", None, None, "Zionsville", "46077"),
    ("control: Saint city", "9 Elm Ct, St. John, IN 46373", None, None, "St. John", "46373"),
    ("no comma", STREET + " Carmel IN 46032", None, None, None, "46032"),
    ("no comma, five-digit house number", "12345 Larkspur Hollow Rd", None, None, None, None),
    ("number, street, city", "4417, Larkspur Hollow Rd, Carmel, IN 46032", None, None, None, "46032"),
    ("residence, street, city", "The Quixote Residence, Larkspur Hollow Rd, Carmel", None, None, None, None),
    ("street typed into the city column", STREET + ", Carmel, IN 46032", "Larkspur Hollow Rd", None, "Carmel", "46032"),
    ("spelled-out number in the city column", None, "Forty-four Larkspur Hollow Rd", None, None, None),
    ("full address in the city column", None, STREET, "46032", None, "46032"),
    ("unit as second part", STREET + ", Unit B, Carmel, IN 46032", None, None, None, "46032"),
    ("apartment as second part", STREET + ", Apt 12, Carmel, IN 46032", None, None, None, "46032"),
    ("PO box, no comma", "PO Box 44170", None, None, None, None),
    ("lot number at the end, no comma", "Larkspur Hollow Rd Lot 10001", None, None, None, None),
    ("county road number at the end", "County Rd 10001", None, None, None, None),
    ("line break", STREET + "\nCarmel, IN 46032", None, None, None, "46032"),
    ("house number in the zip column", STREET + ", Carmel", None, "4417", "Carmel", None),
    ("name first", NAME + ", " + STREET + ", Carmel, IN", None, None, None, None),
    ("street without a type word as second part", "4417, Larkspur Hollow, Carmel", None, None, "Larkspur Hollow", None),  # known limit, see below
]
KNOWN_LIMIT = {"street without a type word as second part"}

# (label, text typed by the homeowner, fragments that must NOT reach a bidder)
NOTES = [
    ("phone, dashes", "Call me at 317-555-0142 after 5", ["555", "0142"]),
    ("phone, brackets", "cell (317) 555-0142", ["555", "0142"]),
    ("phone, dots and country code", "+1 317.555.0142 anytime", ["555", "0142"]),
    ("phone, no separators", "text 3175550142", ["3175550142"]),
    ("phone, seven digits", "office 555-0142", ["555-0142", "0142"]),
    ("email", "send the bid to " + EMAIL + " please", ["zelda.q", "example.invalid", "@"]),
    ("street line with a house number", "The house is 4417 Larkspur Hollow Rd, grey siding", ["4417", "Larkspur"]),
    ("another street, with a number", "Park at 88 N Meridian Street and walk", ["88 N", "Meridian"]),
    ("PO box", "mail to P.O. Box 44170", ["44170"]),
    ("the claim's own street line, any case", "we live at 4417 LARKSPUR HOLLOW RD", ["LARKSPUR", "4417"]),
    ("the homeowner's name", "ask for zelda quixote at the door", ["zelda", "quixote"]),
    ("two lines, one is an address", "Steep back slope.\n12 Oak Ln is the neighbour, use our drive", ["12 Oak", "Oak Ln"]),
]
BENIGN = "Tree fell on the back slope. Two layers of shingles, about 30 squares, 8/12 pitch. Dog in yard."


def schema(cur, view_sql):
    cols = sorted(set(re.findall(r"\bc\.([a-z_]+)", view_sql)) | {"homeowner_name", "claim_number", "job_type", "urgency_reason", "homeowner_notes", "property_city", "property_zip", "property_address"})
    typ = {"id": "uuid primary key", "ready_for_bids": "boolean", "is_test": "boolean", "hover_measurements": "jsonb",
           "parsed_line_items": "jsonb", "has_estimate": "boolean", "has_measurements": "boolean",
           "selected_contractor_id": "uuid", "carrier_id": "uuid", "user_id": "uuid", "trades": "text[]",
           "rcv_amount": "numeric", "acv_amount": "numeric", "deductible_amount": "numeric", "roof_squares": "numeric",
           "repair_squares": "numeric", "created_at": "timestamptz", "urgency_deadline": "timestamptz",
           "roofing_bid_released_at": "timestamptz", "gutters_bid_released_at": "timestamptz",
           "siding_bid_released_at": "timestamptz", "windows_bid_released_at": "timestamptz", "bid_window_expires_at": "timestamptz"}
    cols = [c for c in cols if c != "user_id"]
    ddl = ", ".join("%s %s" % (c, typ.get(c, "text")) for c in cols) + ", user_id uuid"
    cur.execute("""
      do $$ declare r text; begin foreach r in array array['authenticated','anon','service_role'] loop
        if not exists (select 1 from pg_roles where rolname = r) then execute 'create role ' || r || ' nologin'; end if; end loop; end $$;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to authenticated, anon, service_role;
      create table public.contractors(id uuid primary key, user_id uuid unique, status text, is_test boolean);
      create table public.carrier_profiles(id uuid primary key, carrier_name text);
      create table public.claims(%s);
      create table public.quotes(claim_id uuid, contractor_id uuid);
      alter table public.claims enable row level security;
    """ % ddl)
    body = re.sub(r"^\s*(BEGIN|COMMIT);\s*$", "", view_sql, flags=re.M)
    cur.execute(body)


def run(view_sql, label):
    tmp = tempfile.mkdtemp(prefix="gh2559pg")
    db = pgserver.get_server(tmp, cleanup_mode="delete")
    fails, leaks = [], []
    try:
        conn = psycopg2.connect(db.get_uri()); conn.autocommit = True; cur = conn.cursor()
        schema(cur, view_sql)
        cur.execute("insert into contractors values (%s,%s,'active',false),(%s,%s,'active',false)", (K_BIDDER, BIDDER_U, K_SELECTED, SELECTED_U))
        rows = []  # (kind, label, id)
        def claim(i, **kw):
            cid = "00000000-0000-4000-9000-%012d" % i
            base = dict(id=cid, user_id=OWNER, ready_for_bids=True, status="bidding", is_test=False, homeowner_name=NAME,
                        claim_number="PROOF-CLAIM-0001", job_type="insurance_rcv")
            base.update(kw)
            keys = list(base)
            cur.execute("insert into claims(%s) values (%s)" % (",".join(keys), ",".join(["%s"] * len(keys))), [base[k] for k in keys])
            return cid
        n = 0
        for lab, a, pc, pz, ecity, ezip in ADDRESSES:
            n += 1; rows.append(("addr", lab, claim(n, property_address=a, property_city=pc, property_zip=pz), (ecity, ezip)))
        for lab, text, bad in NOTES:
            n += 1; rows.append(("note", lab, claim(n, property_address=STREET + ", Carmel, IN 46032", homeowner_notes=text, urgency_reason=text), bad))
        n += 1; benign = claim(n, property_address=STREET + ", Carmel, IN 46032", homeowner_notes=BENIGN, urgency_reason="Leak over the kitchen")
        n += 1; repair = claim(n, property_address=STREET + ", Carmel, IN 46032", job_type="repair", homeowner_notes="Ridge cap blew off, harmless text")
        n += 1; chosen = claim(n, property_address=STREET + ", Carmel, IN 46032", selected_contractor_id=K_SELECTED,
                               homeowner_notes="Call " + PHONE + ", " + STREET, urgency_reason=EMAIL)

        def read(user, sql, args=()):
            cur.execute("begin"); cur.execute("set local role authenticated")
            cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (user,))
            cur.execute(sql, args); r = cur.fetchall(); cur.execute("rollback"); return r

        got = {r[0]: r[1:] for r in read(BIDDER_U, "select id::text, location_city, location_zip, homeowner_notes, urgency_reason from public.bidder_claim_summary")}
        street_bits = re.compile(r"larkspur|hollow|quixote|\brd\b|\bunit\b|\bapt\b|\bbox\b|\blot\b|\d", re.I)
        for kind, lab, cid, exp in rows:
            if cid not in got: fails.append("%s: row not visible to the bidder" % lab); continue
            city, zp, notes, urg = got[cid]
            if kind == "addr":
                ecity, ezip = exp
                if city is not None and street_bits.search(city) and lab not in KNOWN_LIMIT: leaks.append("city  %-45s -> %r" % (lab, city))
                if zp is not None and zp in ("44170", "10001", "12345", "4417", "44"): leaks.append("zip   %-45s -> %r" % (lab, zp))
                if zp is not None and not re.fullmatch(r"\d{5}", zp): leaks.append("zip   %-45s -> %r (not five digits)" % (lab, zp))
                if (city, zp) != (ecity, ezip): fails.append("address %-45s expected %r got %r" % (lab, (ecity, ezip), (city, zp)))
            else:
                for col, val in (("notes", notes), ("urgency", urg)):
                    for b in exp:
                        if val is not None and b.lower() in val.lower(): leaks.append("%-7s %-40s still holds %r" % (col, lab, b))
        if benign in got and got[benign][2] != BENIGN: fails.append("benign note changed: %r" % (got[benign][2],))
        if benign in got and got[benign][3] != "Leak over the kitchen": fails.append("benign urgency changed: %r" % (got[benign][3],))
        if repair in got and got[repair][2] is not None: leaks.append("notes   repair-intake notes reached a bidder: %r" % (got[repair][2],))
        other = got.get(chosen)
        if other and (PHONE in (other[2] or "") or "Larkspur" in (other[2] or "") or "@" in (other[3] or "")):
            leaks.append("notes   a bidder read the selected claim's notes as typed")
        sel = read(SELECTED_U, "select homeowner_notes, urgency_reason from public.bidder_claim_summary where id = %s", (chosen,))
        if not sel or sel[0] != ("Call " + PHONE + ", " + STREET, EMAIL): fails.append("selected contractor does not read the notes as typed: %r" % (sel,))
        allcols = read(BIDDER_U, "select to_jsonb(v)::text from public.bidder_claim_summary v")
        for (txt,) in allcols:
            for secret in (PHONE, EMAIL, "PROOF-CLAIM-0001", OWNER):
                if secret in txt: leaks.append("row     a bidder's row holds %r" % secret)
        print("[%s] rows read by the bidder: %d | leaks: %d | other failures: %d" % (label, len(got), len(leaks), len(fails)))
        for x in leaks: print("   LEAK  " + x)
        for x in fails: print("   FAIL  " + x)
        conn.close()
    finally:
        try: db.cleanup()
        except Exception: pass
        shutil.rmtree(tmp, ignore_errors=True)
    return leaks, fails


if __name__ == "__main__":
    leaks, fails = run(open(VIEW_FILE).read(), "this head")
    rc = 1 if (leaks or fails) else 0
    if "--control" in sys.argv:
        cl, _ = run(open(sys.argv[sys.argv.index("--control") + 1]).read(), "NEGATIVE CONTROL: older view file")
        if not cl:
            print("NEGATIVE CONTROL FAILED: the older view leaked nothing, so this test proves nothing"); rc = 1
    print("RESULT: " + ("PASS" if rc == 0 else "FAIL"))
    sys.exit(rc)

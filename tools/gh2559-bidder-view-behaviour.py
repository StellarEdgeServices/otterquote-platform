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
    ("street type then compass word, second part", "4417, Larkspur Hollow Rd N, Carmel, IN 46032", None, None, None, "46032"),
    ("street type then compass word, city column", STREET + ", Carmel, IN 46032", "Larkspur Hollow Rd N", None, "Carmel", "46032"),
    ("street type then spelled compass, city column", None, "Meridian Street East", "46032", None, "46032"),
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
# The 43 shapes of review 6049068071 (PR #2578), verbatim from the reviewer's harness. The claim they sit on
# has the address R_ADDR; the homeowner's name is ONLY in profiles.full_name (claims.homeowner_name is NULL,
# as on every real claim in production).
R_NAME, R_ADDR = "Marisol Vanterpool", "123 N Main St Apt 4, Fishers, IN 46038"
REVIEW_NOTES = [
 ("phone dots","call 463.555.0187 pls",["555","0187"]),
 ("phone spaces","call 463 555 0187 pls",["555 0187","0187"]),
 ("phone slashes","call 463/555/0187",["555","0187"]),
 ("phone en-dash","call 463–555–0187",["0187"]),
 ("phone nbsp","call 463 555 0187",["0187"]),
 ("phone underscores","463_555_0187",["0187"]),
 ("phone w/ words between","463 then 555 then 0187",["0187"]),
 ("phone split 3-4 on two lines w/ text","cell 463-555\nthen 0187",["0187"]),
 ("phone spelled","four six three 555 0187",["555 0187"]),
 ("phone ext","463-555-0187 x22",["0187"]),
 ("email plus tag","write marisol+roof@vanterpool-mail.example.org",["marisol","vanterpool-mail","@"]),
 ("email spaced dot","marisol @ mailhost . com",["marisol @","mailhost"]),
 ("email 'at' 'dot'","marisol at mailhost dot com",["mailhost"]),
 ("email upper+subdomain","MARISOL.V@MAIL.HOST.CO.UK",["MARISOL","HOST"]),
 ("email no tld","marisol@mailhost",["marisol@"]),
 ("addr: 123 N Main St Apt 4 (own, exact)","We are at 123 N Main St Apt 4",["123 N","Main St","Apt 4"]),
 ("addr: own, type spelled out","We are at 123 North Main Street, apartment 4",["123","Main"]),
 ("addr: own, no type word","house is 123 N Main, blue door",["123 N Main"]),
 ("addr: own, double space","at 123  N Main St Apt 4",["Main St"]),
 ("addr: own, no unit","at 123 N Main St",["123 N Main"]),
 ("addr: other street no type word","park at 9021 Larkspur Hollow and walk",["9021","Larkspur"]),
 ("addr: number AFTER street","Larkspur Hollow Rd #9021",["9021","Larkspur"]),
 ("addr: county road grid","we are 9021 N 500 W",["9021 N 500"]),
 ("addr: type not in list (Pass)","9021 Eagle Pass is the house",["9021","Eagle Pass"]),
 ("addr: type not in notes list (Run)","9021 Fox Run",["9021","Fox Run"]),
 ("addr: type Ridge/Bend/Cove/Trace/Point","8 Otter Ridge; 7 River Bend; 6 Quiet Cove; 5 Deer Trace; 4 West Point",["Otter Ridge","River Bend","Quiet Cove","Deer Trace"]),
 ("addr: Broadway (single word)","9021 Broadway",["9021 Broadway"]),
 ("addr: spelled number","Ninety Twenty-One Larkspur Hollow Rd",["Larkspur"]),
 ("addr: street w/o number","corner of Larkspur Hollow Rd and Main",["Larkspur"]),
 ("addr: number, 5+ words, type","9021 Old North East Little Big Larkspur Hollow Rd",["9021","Larkspur"]),
 ("addr: tab separated","9021\tLarkspur\tRd",["9021","Larkspur"]),
 ("addr: on line 2 of 3","Steep roof.\nWe're at 9021 Larkspur Rd.\nDog in yard.",["9021","Larkspur"]),
 ("name: full","ask for Marisol Vanterpool",["Marisol","Vanterpool"]),
 ("name: first only","ask for Marisol",["Marisol"]),
 ("name: last only","the Vanterpool house",["Vanterpool"]),
 ("name: reversed","Vanterpool, Marisol",["Marisol","Vanterpool"]),
 ("name: double space","Marisol  Vanterpool",["Vanterpool"]),
 ("name: sign-off","Thanks!\n- Marisol V.",["Marisol"]),
 ("claim number 6 digits","claim no 778899 with State Farm",["778899"]),
 ("claim number alnum","claim CLM-77-8899-A1",["8899"]),
 ("gate code","gate code 4417",["4417"]),
 ("url","see photos at marisolsroof.example.com/p?id=3",["marisolsroof"]),
 ("social handle","IG @marisol_vanterpool_home",["marisol_vanterpool"]),
]

# Shapes NOT redacted on purpose: the same pattern would blank an ordinary job description ("roof is 200 sq,
# garage 400 sq, built 1998" is three digit groups with words between). Listed for the CEO to accept in
# writing (pre-flight, RESIDUALS). The test reports them and fails if the set ever changes silently.
REVIEW_RESIDUALS = {"phone w/ words between", "phone split 3-4 on two lines w/ text"}
REVIEW_BENIGN = ["Tree fell on the back slope. 30 squares, 8/12 pitch, 2 layers.","Budget around $12,500.00, deductible 1000","Need it done before 10/31/2026","Insurance approved 2026-09-14; adjuster visit done","Skylight 22.5 x 46.5 in; 3 pipe boots; 120 ft of ridge","Hail on 6-12-2026 about 1.75 inch"]
# ordinary descriptions that must come back UNCHANGED (over-redaction guard). The two ISO / dashed dates of
# the reviewer's list lose their date to the phone rule and are checked for that exact outcome below.
MORE_BENIGN = ["Roof is 200 sq, garage 400 sq, built 1998", "120 ft of ridge, 3 ridge vents, 40 ft gutter run",
               "about 30 sq total and 2 layers", "Use the best way in from the road, our drive is steep",
               "2 story, 8/12 pitch, 25 squares, hail in June", "we may need new decking, will pay cash"]

# Review 6050015567 (head 08db93cd) and Ben 6050104102: the claim's own address on a NUMBERED street typed without
# "St"; names as plurals, glued, underscored or with accents; email written as "x at gmail.com" or with .edu.
# Three owners, each with the name ONLY in profiles.full_name. Each tuple: (label, text, fragments that must NOT reach a bidder).
N_NAME, N_ADDR = "Marisol Vanterpool", "1420 E 96th St, Indianapolis, IN 46240"
A_NAME, A_ADDR = "Jos\u00e9 N\u00fa\u00f1ez", "77 Elm Ct, Carmel, IN 46032"
S_NAME, S_ADDR = "Joe Smith", "88 Oak Ln, Fishers, IN 46038"
NUMBERED = [
 ("numbered: own, no type word","house is 1420 E 96th, blue door",["1420","96th"]),
 ("numbered: own, lower case","we're at 1420 e 96th",["1420","96th"]),
 ("numbered: own, spelled-out compass","1420 East 96th, ring bell",["1420","96th"]),
 ("numbered: other street, ordinal","my mom is at 305 W 116th if I'm out",["305","116th"]),
 ("numbered: other, short house number","at 12 146th, gray barn",["146th"]),
 ("numbered: other, no compass","go to 4417 62nd for the key",["4417","62nd"]),
 ("numbered: control, with the type word","we are at 1420 E 96th St",["1420","96th"]),
]
NAMES = [
 ("name: plural","the Vanterpools live here",["Vanterpool"]),
 ("name: possessive","Vanterpool's roof",["Vanterpool"]),
 ("name: underscored","marisol_vanterpool",["marisol","vanterpool"]),
 ("name: glued, lower case","marisolvanterpool",["marisol","vanterpool"]),
 ("name: glued, camel case","MarisolVanterpool",["Marisol","Vanterpool"]),
 ("name: digits glued","vanterpool2024 is my login",["vanterpool"]),
]
ACCENT = [
 ("name: accented as on the profile","ask for Jos\u00e9 N\u00fa\u00f1ez",["Nu","Jos"]),
 ("name: accents dropped","ask for Jose Nunez",["Nunez","Jose"]),
 ("name: accented, last name only","the N\u00fa\u00f1ez house",["ez"]),
]
SHORT = [
 ("name: short name, camel case","JoeSmith called",["Joe","Smith"]),
 ("name: short name, plural","the Smiths are away",["Smith"]),
]
EMAILS = [
 ("email: 'at' with a dotted domain","write roofgal77 at gmail.com",["roofgal77","gmail"]),
 ("email: .edu with 'at'","jdoe at purdue.edu",["jdoe","purdue"]),
 ("email: .edu with @","jdoe@purdue.edu",["jdoe","purdue"]),
 ("email: .gov","jdoe@indy.gov",["jdoe","indy"]),
 ("email: (at)(dot)","x(at)y(dot)com",["x(at)","(dot)"]),
 ("email: [at] [dot]","x [at] y [dot] com",["[at]","[dot]"]),
 ("email: at dot","jane at mailhost dot edu",["jane","mailhost"]),
]
# ordinary text that must come back unchanged on the same claims (over-redaction guard)
N_BENIGN = ["leak at the 96th percentile of rainfall","Ridge vent at 40 ft; new 2nd-story window flashing","3 2nd-story windows and a bay","Meet me at 3.5 hours after rain","The roofer arrived at 8.30 and left at 4.15",
            "Ladder at the south side; ask for a quote at the door"]

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
      create table public.profiles(id uuid primary key, full_name text);
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

        got = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.location_city, v.location_zip, v.homeowner_notes, to_jsonb(v)->>'urgency_reason' from public.bidder_claim_summary v")}
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
        if benign in got and got[benign][3] not in (None, "Leak over the kitchen"): fails.append("benign urgency changed: %r" % (got[benign][3],))
        if repair in got and got[repair][2] is not None: leaks.append("notes   repair-intake notes reached a bidder: %r" % (got[repair][2],))
        other = got.get(chosen)
        if other and (PHONE in (other[2] or "") or "Larkspur" in (other[2] or "") or "@" in (other[3] or "")):
            leaks.append("notes   a bidder read the selected claim's notes as typed")
        sel = read(SELECTED_U, "select v.homeowner_notes, to_jsonb(v)->>'urgency_reason' from public.bidder_claim_summary v where v.id = %s", (chosen,))
        if not sel or sel[0][0] != "Call " + PHONE + ", " + STREET or sel[0][1] not in (None, EMAIL): fails.append("selected contractor does not read the notes as typed: %r" % (sel,))
        # ---- review 6049068071: the reviewer's 43 shapes; the name lives in profiles only
        OWNER2 = "00000000-0000-4000-8000-000000000077"
        cur.execute("insert into profiles values (%s, %s)", (OWNER2, R_NAME))
        rv = []
        for lab, text, bad in REVIEW_NOTES:
            n += 1; rv.append((lab, text, bad, claim(n, user_id=OWNER2, homeowner_name=None, claim_number=None, property_address=R_ADDR, homeowner_notes=text, urgency_reason=text)))
        bn = []
        for text in REVIEW_BENIGN + MORE_BENIGN:
            n += 1; bn.append((text, claim(n, user_id=OWNER2, homeowner_name=None, claim_number=None, property_address=R_ADDR, homeowner_notes=text, urgency_reason=text)))
        got2 = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.homeowner_notes, to_jsonb(v)->>'urgency_reason' from public.bidder_claim_summary v")}
        blanked, residual_seen = 0, set()
        for lab, text, bad, cid in rv:
            vals = got2.get(cid, (text, text))
            hit = [b for b in bad for v in vals if v is not None and b.lower() in v.lower()]
            if not hit: blanked += 1
            elif lab in REVIEW_RESIDUALS: residual_seen.add(lab); print("   RESIDUAL (stated, for the CEO) %-40s -> %r" % (lab, vals[0]))
            else: leaks.append("review  %-40s still holds %r -> %r" % (lab, hit[0], vals[0]))
        for lab in REVIEW_RESIDUALS - residual_seen: fails.append("a stated residual is now redacted, update REVIEW_RESIDUALS and the pre-flight: %s" % lab)
        DATE_LOSS = {"Insurance approved 2026-09-14; adjuster visit done", "Hail on 6-12-2026 about 1.75 inch"}
        for text, cid in bn:
            v = got2.get(cid, (None, None))[0]
            if text in DATE_LOSS:
                if v is None or "[removed]" not in v: fails.append("expected the date in %r to be lost to the phone rule, got %r" % (text, v))
            elif v != text: fails.append("OVER-REDACTION: %r came back as %r" % (text, v))
        print("[%s] review 6049068071 shapes blanked: %d of %d | stated residuals: %d" % (label, blanked, len(rv), len(residual_seen)))

        # ---- review 6050015567 / Ben 6050104102
        OW_N, OW_A, OW_S = ["00000000-0000-4000-8000-0000000000%02d" % i for i in (81, 82, 83)]
        for o, nm in ((OW_N, N_NAME), (OW_A, A_NAME), (OW_S, S_NAME)): cur.execute("insert into profiles values (%s, %s)", (o, nm))
        grp = [(NUMBERED + NAMES + EMAILS, OW_N, N_ADDR), (ACCENT, OW_A, A_ADDR), (SHORT, OW_S, S_ADDR)]
        rv2 = []
        for items, ow, addr in grp:
            for lab, text, bad in items:
                n += 1; rv2.append((lab, text, bad, claim(n, user_id=ow, homeowner_name=None, claim_number=None, property_address=addr, homeowner_notes=text, urgency_reason=text)))
        bn2 = []
        for text in N_BENIGN:
            n += 1; bn2.append((text, claim(n, user_id=OW_N, homeowner_name=None, claim_number=None, property_address=N_ADDR, homeowner_notes=text, urgency_reason=text)))
        got3 = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.homeowner_notes, to_jsonb(v)->>'urgency_reason' from public.bidder_claim_summary v")}
        b2 = 0
        for lab, text, bad, cid in rv2:
            vals = got3.get(cid, (text, text))
            hit = [b for b in bad for v in vals if v is not None and b.lower() in v.lower()]
            if not hit: b2 += 1
            else: leaks.append("r6050  %-42s still holds %r -> %r" % (lab, hit[0], vals[0]))
        for text, cid in bn2:
            v = got3.get(cid, (None, None))[0]
            if v != text: fails.append("OVER-REDACTION: %r came back as %r" % (text, v))
        print("[%s] review 6050015567 + Ben 6050104102 shapes blanked: %d of %d" % (label, b2, len(rv2)))

        # ---- free-text catalogue columns (shingle brand / colour, measurement shape) and the dropped urgency_reason
        n += 1; cat_bad = claim(n, property_address=STREET + ", Carmel, IN 46032", existing_shingle_brand="call 317 555 0142", existing_shingle_color="mail zelda.q@example.invalid", measurement_shape="x" * 80)
        n += 1; cat_ok = claim(n, property_address=STREET + ", Carmel, IN 46032", existing_shingle_brand="GAF Timberline HD", existing_shingle_color="Charcoal", measurement_shape="hip")
        cat = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.existing_shingle_brand, v.existing_shingle_color, v.measurement_shape from public.bidder_claim_summary v")}
        if cat.get(cat_bad) != (None, None, None): leaks.append("catalogue  a phone, an email or an 80-character shape reached a bidder: %r" % (cat.get(cat_bad),))
        if cat.get(cat_ok) != ("GAF Timberline HD", "Charcoal", "hip"): fails.append("catalogue  an ordinary brand, colour and shape changed: %r" % (cat.get(cat_ok),))
        has_urg = read(BIDDER_U, "select count(*) from information_schema.columns where table_name = 'bidder_claim_summary' and column_name = 'urgency_reason'")[0][0]
        print("[%s] urgency_reason exposed by the view: %s" % (label, "YES" if has_urg else "no"))
        if has_urg and label == "this head": fails.append("urgency_reason is exposed; no bidder page shows it")
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

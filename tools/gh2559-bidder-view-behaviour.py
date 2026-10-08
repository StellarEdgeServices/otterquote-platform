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
import json, os, re, shutil, sys, tempfile, time

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


# ---- review 6051111207 (head cf8d98e1) and the task fix2578b. Every list below is read through the view as a bidder.
# (a) damage_type: a free-text box on the two insurance intake forms. Only damage words may come back; the rest reads 'Other'.
DAMAGE_LEAK = [
 "Hail - call 463-555-0164", "Hail at 2718 Juniper Bend", "Rosalind Ketterby", "rketterby@fastmail.example", "gate code 4417",
 "Wind, call my wife Dana", "hail; see rozziesplace.net/roof", "Roof at Juniper Bend Ct", "Hail 2024 claim CLM-77-8899", "Wind damage - ask for Rosalind",
 "Hail (Juniper Bend)", "Tree fell, key under mat", "röof häil Ketterby", "Hail" + " " * 3 + "x" * 80, "Wind\nrketterby@fastmail.example",
 "wind, hail, 463 555 0164", "Roof - Rosalind K", "Storm @rozziek74", "Hail, Juniper Bend Estates", "Fire at 4417 Larkspur",
]
DAMAGE_OK = ["roof", "Roof — Hail & Wind", "Wind, Hail", "tree / wind", "Hail", "Age / Wear", "Roof + Gutters", "Wind — Partial", "hail and wind", "Storm damage",
             "Water leak", "Ice and snow"]
# (b) names the 53-letter table did not fold. (profile name stored on profiles.full_name, address, note, fragments that must NOT reach a bidder)
UNI = [
 ("Nguyễn Thị Hương", "55 Elm Ct, Carmel, IN 46032", [("viet: plain letters", "ask for Huong Nguyen", ["Huong", "Nguyen"]), ("viet: as stored", "ask for Nguyễn Thị Hương", ["Nguy", "Hương", "Huong"])]),
 ("Çağla Yıldız", "55 Elm Ct, Carmel, IN 46032", [("turk: plain letters", "ask for Cagla Yildiz", ["Cagla", "Yildiz"]), ("turk: dotless i typed", "ask for Cağla Yıldız", ["Yıld", "Yildiz"])]),
 ("Antonín Dvořák", "55 Elm Ct, Carmel, IN 46032", [("czech: plain letters", "the Dvorak place; Antonin is home", ["Dvorak", "Antonin"])]),
 ("Søren Ødegård", "55 Elm Ct, Carmel, IN 46032", [("nordic: plain letters", "Soren Odegard here", ["Soren", "Odegard"])]),
 ("Łukasz Żółkiewski", "55 Elm Ct, Carmel, IN 46032", [("polish: plain letters", "the Zolkiewski house, ask for Lukasz", ["Zolkiewski", "Lukasz", "Zol"])]),
 ("José Núñez", "55 Elm Ct, Carmel, IN 46032", [("decomposed profile name, plain note", "ask for Jose Nunez", ["Jose", "Nunez"])]),
 ("Straßer Müller", "55 Elm Ct, Carmel, IN 46032", [("sharp s", "ask for Strasser Mueller or Muller", ["Strasser", "Muller"])]),
 ("Иван Петров", "55 Elm Ct, Carmel, IN 46032", [("cyrillic: declined", "позвоните Ивану Петрову", ["Иван", "Петров"]), ("cyrillic: exact", "Иван Петров", ["Иван", "Петров"])]),
 ("王小明", "55 Elm Ct, Carmel, IN 46032", [("cjk: one token", "请找王小明师傅", ["王小明"])]),
 ("李 明", "55 Elm Ct, Carmel, IN 46032", [("cjk: surname and given name", "李明先生住在这里", ["李", "明"])]),
 ("Marisol Vanterpool", "55 Elm Ct, Carmel, IN 46032", [("zero-width inside the name", "ask for Mari​sol Vanter‍pool", ["Mari", "Vanter"]), ("full-width letters", "ask for Ｍａｒｉｓｏｌ", ["Marisol", "Ｍ"]), ("soft hyphen", "the Vanter­pool house", ["Vanter"])]),
]
UNI_PHONE = [
 ("phone: full-width digits", "call ４６３-５５５-０１８７", ["0187", "０１"]),
 ("phone: zero-width space in each group", "call 4​6​3 5​5​5 0​1​8​7", ["0187", "018"]),
 ("email: full-width @", "marisol＠mailhost.com", ["mailhost", "marisol"]),
]
# (c) shapes the reviewer listed as BLANKED (controls that must stay blanked), on 2718 Juniper Bend Ct Unit 3, Westfield, IN 46074 / Rosalind Ketterby.
# The strings are rebuilt from the review text, not copied from the reviewer's harness.
K_NAME, K_ADDR = "Rosalind Ketterby", "2718 Juniper Bend Ct Unit 3, Westfield, IN 46074"
KEEP_BLANKED = [
 ("zwj between phone groups", "call 463‍555‍0164", ["0164"]),
 ("emoji separators", "463\U0001F4DE555\U0001F4DE0164", ["0164"]),
 ("tel: uri", "tel:+14635550164", ["0164"]),
 ("email with a zero-width space", "rozzie​@example.invalid", ["example"]),
 ("AT ... DOT upper case", "rozziek74 AT mailhost DOT com", ["mailhost", "rozziek74"]),
 ("handle with @", "@rozziek74 on insta", ["rozziek74"]),
 ("web address .net/roof", "see rozziesplace.net/roof", ["rozziesplace"]),
 ("lat long, five decimals", "pin 40.04281, -86.12754", ["04281", "12754"]),
 ("parcel number", "parcel 29-05-12-100-044.000-013", ["044"]),
 ("own address, unit, no street type", "we are 2718 Juniper Bend #3", ["2718", "Juniper"]),
 ("street then number", "Juniper Bend Ct 2718", ["2718", "Juniper"]),
 ("hash then house number after the street", "Juniper Bend #2718", ["2718", "Juniper"]),
 ("other address, unit, no type", "at 905 Maple Grove #4", ["905", "Maple"]),
 ("initial and surname", "ask for R. Ketterby", ["Ketterby"]),
]
# (c2) shapes this commit closes that the old head let through
NEW_SHAPES = [
 ("three-and-four digits split by a slash", "reach me 555/0164", ["0164"]),
 ("scheme-less address with a path, unlisted ending", "see rozzie.homes/roof", ["rozzie.homes"]),
 ("scheme-less address with a path, another ending", "photos at rozziesplace.photos/roof-2024", ["rozziesplace"]),
]
# (d) ordinary job descriptions that must come back UNCHANGED (review 6051111207 finding 4)
OVER = [
 "Roof is about 2400 Square Feet, 6/12 pitch.", "About 3000 SF, two layers, installed 2009 GAF Timberline.", "Gutters: 180 LF of 6 inch, 4 downspouts.",
 "NEED 28 SQUARES REPLACED, 150 MPH WIND RATED SHINGLES.", "3 tab shingles, steep drive, please park on the road.", "2 story house, the only way up is from the back.",
 "Please replace 5 vents and fix the place where the flashing lifted.", "Old roof is 25 years old. 3 Bids Wanted. Drive is shared with the neighbour.",
 "Roof 2400 SQ FT, steep drive", "Installed 2012 Owens Corning Duration, 30 squares", "180 LF fascia and 4 Downspouts", "Two layers, 1998 CertainTeed Landmark, 28 Squares",
]
# (d2) CEO ruling 6063622505 item 1: a note is removed WHOLE when it holds one of the claim's own street-name words of
# five letters or more, with no house number needed. (label, claim address, note, removed whole?)
# K_ADDR gives juniper (seven letters; a street-name word) and bend (four letters; below the cut).
# "1234 North Yorkshire Circle" gives yorkshire; north and circle are a compass word and a street type, which the
# view's street-word list has always left out (a note saying "north side" or "circle drive" is an ordinary description).
Y_ADDR = "1234 North Yorkshire Circle, Westfield, IN 46074"
OWN5 = [
 ("own street word, no house number", K_ADDR, "blue house on Juniper Bend, third from the corner", True),
 ("same note without the street word", K_ADDR, "blue house on the corner, third from the end", False),
 ("own street word, lower case", K_ADDR, "the juniper bend place, ask the neighbours", True),
 ("own street word, upper case", K_ADDR, "WE ARE ON JUNIPER", True),
 ("own street word, mixed case", K_ADDR, "Meet at jUnIpEr and turn left", True),
 ("own street word, with a trailing comma", K_ADDR, "off Juniper, second drive", True),
 ("four-letter street word does not trigger", K_ADDR, "gutter runs round the bend by the porch", False),
 ("street word glued inside a longer word does not trigger", K_ADDR, "junipers along the fence need cutting back", False),
 ("longer street word, no house number", Y_ADDR, "the Yorkshire side of the house, two storeys", True),
 ("compass word alone does not trigger", Y_ADDR, "the north side of the roof has the hail damage", False),
 ("street type alone does not trigger", Y_ADDR, "there is a circle drive at the front, park there", False),
]
# (e) brand / colour boxes (repair intake and homeowner dashboard)
CAT_LEAK = ["rozziesplace.net/roof", "rozziek74 at gmail.com", "x at gmail.com", "bit.ly/3xRoofQ", "rozziesplace dot com", "call my wife Dana", "gate code 4417",
            "2718 Juniper Bend Ct Unit 3", "４６３-５５５-０１６４", "mail zelda.q@example.invalid", "call 317 555 0142", "www.example.invalid", "rozziek74@gmail"]
CAT_OK = [("GAF Timberline HD", "Charcoal"), ("Owens Corning Oakridge", "Weathered Wood"), ("CertainTeed Landmark", "Pewter Gray"), ("IKO Cambridge", "Mission Brown"),
          ("TAMKO Heritage", "Black Walnut"), ("Atlas Pinnacle", "Estate Gray")]
CAT_RESIDUAL = ["Rosalind Ketterby"]  # a plain name in the brand box is NOT caught; stated in the pre-flight

# ---- PINNED BEHAVIOUR (task cap2578, from the delta review 6066637484). Each row records what the view does TODAY with one
# shape the reviewer found; none of them is a requirement and none is changed by this PR. "removed" = the note comes back as
# "[removed]" (the rule works); "removed-in-part" = only the street word goes ("we are on [removed]"; an older rule). "survives" = the note comes back as typed: ACCEPTED-OR-PENDING-CEO (the CEO closed the residual
# list for this PR, ruling 6063622505; these go to him as questions on #2559, not as changes here). If the view ever changes
# one of them, this test fails and says which, so the change is made on purpose. (label, claim address, note, outcome, expected text)
Y_ADDR2 = "1234 North Yorkshire Circle, Westfield, IN 46074"
OB_ADDR = "12 O'Brien Ln, Carmel, IN 46032"
WS_ADDR = "9 Winston-Salem Rd, Carmel, IN 46032"
PINNED = [
 # possessive and plural of the street word
 ("possessive: Yorkshire's", Y_ADDR2, "Yorkshire's roof is the one with the hail damage", "removed", "[removed]"),
 ("plural glued: Yorkshires", Y_ADDR2, "the Yorkshires are away", "survives", "the Yorkshires are away"),
 # apostrophe in the street name (the tokens are brien; o is under three letters)
 ("apostrophe: O'Brien", OB_ADDR, "corner of O'Brien", "removed", "[removed]"),
 ("apostrophe, curly: O\u2019Brien", OB_ADDR, "corner of O\u2019Brien", "removed", "[removed]"),
 ("apostrophe, space: O Brien", OB_ADDR, "corner of O Brien", "removed", "[removed]"),
 ("apostrophe dropped: OBrien", OB_ADDR, "corner of OBrien", "survives", "corner of OBrien"),
 ("apostrophe dropped, lower case: Obrien", OB_ADDR, "corner of Obrien lane", "survives", "corner of Obrien lane"),
 ("address without the apostrophe, note with it", "12 OBrien Ln, Carmel, IN 46032", "corner of O'Brien", "survives", "corner of O'Brien"),
 # hyphenated street names (each half is a token)
 ("hyphen: Winston-Salem", WS_ADDR, "on Winston-Salem", "removed", "[removed]"),
 ("hyphen: one half alone", WS_ADDR, "on Salem", "removed", "[removed]"),
 ("hyphen dropped: WinstonSalem", WS_ADDR, "on WinstonSalem", "survives", "on WinstonSalem"),
 ("hyphen in the note only: juniper-bend", K_ADDR, "off juniper-bend, second drive", "removed", "[removed]"),
 # the street word glued to another letter, digit or underscore (whole-word matching, ruling 6063622505 cites lines 249-250)
 ("glued: JuniperBend", K_ADDR, "blue house on JuniperBend", "survives", "blue house on JuniperBend"),
 ("glued: Juniper_Bend", K_ADDR, "blue house on Juniper_Bend", "survives", "blue house on Juniper_Bend"),
 ("glued: Junipers", K_ADDR, "the Junipers cul-de-sac house", "survives", "the Junipers cul-de-sac house"),
 ("glued: Juniper2718", K_ADDR, "Juniper2718 is us", "survives", "Juniper2718 is us"),
 # a street NAMED with a word the view's street-word list leaves out (street type, compass word, unit word)
 ("excluded word: North St", "120 North St, Westfield, IN 46074", "we are on north, by the school", "survives", "we are on north, by the school"),
 ("excluded word: North St, spelled out", "120 North St, Westfield, IN 46074", "we are on North Street", "removed-in-part", "we are on [removed]"),
 ("excluded word: Circle Dr", "900 Circle Dr, Westfield, IN 46074", "on circle, white house", "survives", "on circle, white house"),
 ("excluded word: Circle Dr, capitalised", "900 Circle Dr, Westfield, IN 46074", "turn onto Circle, white house", "survives", "turn onto Circle, white house"),
 # the first comma part of the address is not the street line
 ("address: unit first", "Unit 3, 2718 Juniper Bend Ct, Westfield, IN 46074", "house on Juniper Bend", "survives", "house on Juniper Bend"),
 ("address: bare number first", "2718, Juniper Bend Ct, Westfield, IN 46074", "house on Juniper Bend", "survives", "house on Juniper Bend"),
 ("address: a name first", "The Ketterby Residence, 2718 Juniper Bend Ct, Westfield", "house on Juniper Bend", "survives", "house on Juniper Bend"),
 ("address: null", None, "house on Juniper Bend", "survives", "house on Juniper Bend"),
]

# ---- LONG INPUTS (Major 1 of the delta review 6066637484). The claim's address, the homeowner's name and the claim number
# become regular expressions inside the view. A very long value used to make the regular-expression compiler fail with
# "regular expression is too complex" after about 36 seconds, which emptied every bidder's whole list. Each case below is read
# ALONE (a failing row would otherwise hide the others), as a bidder, with a 10-second statement timeout. It must return
# within 5 seconds, with the note either as typed or "[removed]", and no error. (label, owner profile name or None, claim fields)
def _words(count, prefix="q"):
    out, i = [], 0
    while len(out) < count:
        w, k = "", i
        for _ in range(4): w, k = chr(97 + k % 26) + w, k // 26
        out.append(prefix + w); i += 1
    return out
LONG_NOTE = "blue house on the corner, third from the end, steep back slope"
LONG_CASES = [
 ("address: one word of 100000 letters, house number", None, dict(property_address="2718 " + "x" * 100000 + ", Westfield, IN 46074")),
 ("address: one word of 100000 letters, no house number", None, dict(property_address="x" * 100000 + ", Westfield, IN 46074")),
 ("address: 100000 letters, no comma", None, dict(property_address="2718 Juniper " + "x" * 100000)),
 ("address: 5000 short words", None, dict(property_address="2718 " + " ".join(_words(5000)) + ", Westfield, IN 46074")),
 ("address: 5000 two-letter words", None, dict(property_address="2718 " + " ".join(["ab"] * 5000) + ", Westfield, IN 46074")),
 ("address: a house number of 100000 digits", None, dict(property_address="7" * 100000 + " Juniper Bend Ct, Westfield, IN 46074")),
 ("name: profile name, one word of 100000 letters", "y" * 100000, dict(property_address=K_ADDR)),
 ("name: profile name, 5000 short words", " ".join(_words(5000, "z")), dict(property_address=K_ADDR)),
 ("name: profile name, 100000 non-Latin characters", "\u0416" * 100000, dict(property_address=K_ADDR)),
 ("name: claim homeowner_name, one word of 100000 letters", None, dict(property_address=K_ADDR, homeowner_name="y" * 100000)),
 ("claim number of 100000 characters", None, dict(property_address=K_ADDR, claim_number="CLM-" * 25000)),
 ("brand, colour and damage type of 100000 characters", None, dict(property_address=K_ADDR, existing_shingle_brand="b" * 100000, existing_shingle_color="c" * 100000, damage_type="d" * 100000)),
 ("city column of 100000 characters", None, dict(property_address=K_ADDR, property_city="e" * 100000)),
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


        # ---- review 6051111207 + task fix2578b
        def plant(items_user, addr, text, **kw):
            nonlocal n
            n += 1
            return claim(n, user_id=items_user, homeowner_name=None, claim_number=None, property_address=addr, homeowner_notes=text, **kw)
        OWK = "00000000-0000-4000-8000-000000000091"
        cur.execute("insert into profiles values (%s, %s)", (OWK, K_NAME))
        dm = [(t, plant(OWK, K_ADDR, "x", damage_type=t)) for t in DAMAGE_LEAK + DAMAGE_OK]
        n += 1; dnull = claim(n, user_id=OWK, homeowner_name=None, claim_number=None, property_address=K_ADDR, damage_type=None)
        uni = []
        for i, (pname, addr, items) in enumerate(UNI):
            ow = "00000000-0000-4000-8000-0000000001%02d" % i
            cur.execute("insert into profiles values (%s, %s)", (ow, pname))
            for lab, text, bad in items: uni.append((lab, text, bad, plant(ow, addr, text)))
        for lab, text, bad in UNI_PHONE: uni.append((lab, text, bad, plant(OWK, K_ADDR, text)))
        keep = [(lab, text, bad, plant(OWK, K_ADDR, text)) for lab, text, bad in KEEP_BLANKED]
        newsh = [(lab, text, bad, plant(OWK, K_ADDR, text)) for lab, text, bad in NEW_SHAPES]
        over = [(text, plant(OWK, K_ADDR, text)) for text in OVER]
        own5 = [(lab, text, rem, plant(OWK, addr, text)) for lab, addr, text, rem in OWN5]
        got4 = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.homeowner_notes, v.damage_type from public.bidder_claim_summary v")}
        d_clean = d_kept = 0
        for t, cid in dm:
            v = got4.get(cid, (None, t))[1]
            if t in DAMAGE_OK:
                if v == t: d_kept += 1
                else: fails.append("damage_type: an ordinary value changed: %r -> %r" % (t, v))
            elif v == t: leaks.append("damage  typed text came back as typed: %r" % (t,))
            else:
                d_clean += 1
                if v != "Other": fails.append("damage_type: expected 'Other' for %r, got %r" % (t, v))
        if got4.get(dnull, (None, "x"))[1] is not None: fails.append("damage_type: NULL did not stay NULL")
        print("[%s] damage_type typed text refused: %d of %d | ordinary damage words kept: %d of %d" % (label, d_clean, len(DAMAGE_LEAK), d_kept, len(DAMAGE_OK)))
        def judge(group, items):
            ok = 0
            for lab, text, bad, cid in items:
                v = got4.get(cid, (text, None))[0]
                hit = [b for b in bad if v is not None and b.lower() in v.lower()]
                if hit: leaks.append("%-8s %-40s still holds %r -> %r" % (group, lab, hit[0], v))
                else: ok += 1
            print("[%s] %s shapes blanked: %d of %d" % (label, group, ok, len(items)))
        judge("unicode names, phone and email", uni)
        judge("reviewer's blanked controls", keep)
        judge("new shapes (slash phone, address with a path)", newsh)
        o_ok = 0
        for text, cid in over:
            v = got4.get(cid, (None,))[0]
            if v == text: o_ok += 1
            else: fails.append("OVER-REDACTION: %r came back as %r" % (text, v))
        print("[%s] ordinary quantities and phrases kept as typed: %d of %d" % (label, o_ok, len(over)))
        w_ok = 0
        for lab, text, rem, cid in own5:
            v = got4.get(cid, (text, None))[0]
            if rem and v == "[removed]": w_ok += 1
            elif rem: leaks.append("own street  %-48s not removed whole: %r" % (lab, v))
            elif v == text: w_ok += 1
            else: fails.append("OVER-REDACTION (own street word rule): %-40s %r came back as %r" % (lab, text, v))
        print("[%s] claim's own street-name word (5+ letters) removes the note whole / others pass: %d of %d" % (label, w_ok, len(own5)))
        cats = [(b, c, claim(n + 1 + i, property_address=K_ADDR, existing_shingle_brand=b, existing_shingle_color=c)) for i, (b, c) in enumerate([(x, "Charcoal") for x in CAT_LEAK] + [("GAF", x) for x in CAT_LEAK])]
        n += len(cats)
        cats2 = [(b, c, claim(n + 1 + i, property_address=K_ADDR, existing_shingle_brand=b, existing_shingle_color=c)) for i, (b, c) in enumerate(CAT_OK + [(x, x) for x in CAT_RESIDUAL])]
        n += len(cats2)
        cg = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.existing_shingle_brand, v.existing_shingle_color from public.bidder_claim_summary v")}
        c_clean = 0
        for b, c, cid in cats:
            gb, gc = cg.get(cid, (b, c))
            if (b in CAT_LEAK and gb is not None) or (c in CAT_LEAK and gc is not None): leaks.append("catalogue  brand/colour came back: %r / %r" % (gb, gc))
            else: c_clean += 1
        c_ok = 0
        for b, c, cid in cats2:
            if (b, c) == (CAT_RESIDUAL[0], CAT_RESIDUAL[0]):
                print("   RESIDUAL (stated, for the CEO) a plain name in the brand and colour boxes comes back: %r" % (cg.get(cid),)); continue
            if cg.get(cid) == (b, c): c_ok += 1
            else: fails.append("catalogue  an ordinary brand/colour changed: %r -> %r" % ((b, c), cg.get(cid)))
        print("[%s] brand and colour boxes: refused %d of %d leaking pairs | ordinary pairs kept %d of %d" % (label, c_clean, len(cats), c_ok, len(CAT_OK)))

        # ---- free-text catalogue columns (shingle brand / colour, measurement shape) and the dropped urgency_reason
        n += 1; cat_bad = claim(n, property_address=STREET + ", Carmel, IN 46032", existing_shingle_brand="call 317 555 0142", existing_shingle_color="mail zelda.q@example.invalid", measurement_shape="x" * 80)
        n += 1; cat_ok = claim(n, property_address=STREET + ", Carmel, IN 46032", existing_shingle_brand="GAF Timberline HD", existing_shingle_color="Charcoal", measurement_shape="full")
        cat = {r[0]: r[1:] for r in read(BIDDER_U, "select v.id::text, v.existing_shingle_brand, v.existing_shingle_color, v.measurement_shape from public.bidder_claim_summary v")}
        if cat.get(cat_bad) != (None, None, None): leaks.append("catalogue  a phone, an email or an 80-character shape reached a bidder: %r" % (cat.get(cat_bad),))
        if cat.get(cat_ok) != ("GAF Timberline HD", "Charcoal", "full"): fails.append("catalogue  an ordinary brand, colour and shape changed: %r" % (cat.get(cat_ok),))
        has_urg = read(BIDDER_U, "select count(*) from information_schema.columns where table_name = 'bidder_claim_summary' and column_name = 'urgency_reason'")[0][0]
        print("[%s] urgency_reason exposed by the view: %s" % (label, "YES" if has_urg else "no"))
        if has_urg and label == "this head": fails.append("urgency_reason is exposed; no bidder page shows it")
        allcols = read(BIDDER_U, "select to_jsonb(v)::text from public.bidder_claim_summary v")
        for (txt,) in allcols:
            for secret in (PHONE, EMAIL, "PROOF-CLAIM-0001", OWNER):
                if secret in txt: leaks.append("row     a bidder's row holds %r" % secret)

        # ---- pinned behaviour (what the view does today with the shapes the delta review found; nothing here is a requirement)
        OWP = "00000000-0000-4000-8000-000000000093"
        cur.execute("insert into profiles values (%s, %s)", (OWP, K_NAME))
        pin = []
        for lab, addr, text, outcome, expect in PINNED:
            n += 1; pin.append((lab, text, outcome, expect, claim(n, user_id=OWP, homeowner_name=None, claim_number=None, property_address=addr, homeowner_notes=text)))
        got5 = {r[0]: r[1] for r in read(BIDDER_U, "select v.id::text, v.homeowner_notes from public.bidder_claim_summary v")}
        p_ok = p_surv = 0
        for lab, text, outcome, expect, cid in pin:
            v = got5.get(cid, "<row missing>")
            if v == expect: p_ok += 1; p_surv += (outcome == "survives")
            else: fails.append("PINNED behaviour changed: %-44s expected %r (%s), got %r" % (lab, expect, outcome, v))
        print("[%s] pinned behaviour unchanged: %d of %d (%d of them are survivors, ACCEPTED-OR-PENDING-CEO, listed in the PR description)" % (label, p_ok, len(pin), p_surv))
        # ---- long inputs: each case read alone as a bidder, 10 s statement timeout; must return in under 5 s without an error
        OWL = "00000000-0000-4000-8000-000000000094"
        def read_one(cid):
            t0 = time.time()
            try:
                cur.execute("begin"); cur.execute("set local role authenticated"); cur.execute("set local statement_timeout = '10s'")
                cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (BIDDER_U,))
                cur.execute("select v.homeowner_notes, v.location_city, v.damage_type from public.bidder_claim_summary v where v.id = %s", (cid,))
                r = cur.fetchall(); cur.execute("rollback")
                return time.time() - t0, r, None
            except Exception as e:
                try: cur.execute("rollback")
                except Exception: pass
                return time.time() - t0, None, str(e).strip().splitlines()[0]
        timings = []
        for i, (lab, pname, fields) in enumerate(LONG_CASES):
            ow = "00000000-0000-4000-8000-0000000002%02d" % i
            cur.execute("insert into profiles values (%s, %s)", (ow, pname if pname is not None else "Plain Person"))
            n += 1; cid = claim(n, user_id=ow, **dict(dict(homeowner_name=None, claim_number=None, homeowner_notes=LONG_NOTE), **fields))
            secs, r, err = read_one(cid)
            timings.append((lab, secs, err))
            if err: fails.append("LONG INPUT: %-52s raised after %.1f s: %s" % (lab, secs, err))
            elif not r: fails.append("LONG INPUT: %-52s the row did not come back" % lab)
            elif r[0][0] not in (LONG_NOTE, "[removed]"): fails.append("LONG INPUT: %-52s note came back as %r" % (lab, r[0][0]))
            elif secs > 5: fails.append("LONG INPUT: %-52s took %.1f s (limit 5 s)" % (lab, secs))
        # the cap must not cost a real street word: the first words of a padded address still count
        n += 1; pad = claim(n, user_id=OWL, homeowner_name=None, claim_number=None, property_address="2718 Juniper Bend Ct " + " ".join(_words(5000)) + ", Westfield, IN 46074", homeowner_notes="blue house on Juniper, third from the corner")
        cur.execute("insert into profiles values (%s, %s)", (OWL, K_NAME))
        secs, r, err = read_one(pad)
        timings.append(("padded address keeps its first street word", secs, err))
        if err or not r or r[0][0] != "[removed]": fails.append("LONG INPUT: a padded address lost its own street word: %r %r" % (r, err))
        for lab, secs, err in timings: print("   long input  %-56s %6.2f s  %s" % (lab, secs, err or "ok"))
        print("[%s] long inputs: %d cases, slowest %.2f s, errors %d" % (label, len(timings), max(t[1] for t in timings), sum(1 for t in timings if t[2])))
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

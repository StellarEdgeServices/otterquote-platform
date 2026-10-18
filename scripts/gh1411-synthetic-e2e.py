#!/usr/bin/env python3
"""
gh1411-synthetic-e2e.py -- the synthetic end-to-end run authorised for issue #1411
(#1339 comment 5973838709, amended by CEO ruling 6050104990 and closes-on 6021194490).

WHAT IT DOES (on --execute only; the default is a read-only plan):
  1. Preconditions, all or nothing, BEFORE the first write: claim 73208937 is_test,
     buyer contractor is_test, order 3b4622fb is the roof_upgrade_detailed order of that
     claim and is still awaiting_fulfillment with no report, claim shape still NULL.
  2. Ruling 6050104990 addition (1): claims.live_charge_authorized_at -> NULL FIRST,
     before/after pasted, never restored.
  3. hover_orders 3b4622fb: measurements_json (marked source=synthetic_e2e_gh1411),
     status completed, fulfilled_at. Nothing else.
  4. claims 73208937: hover_measurements (same object) and measurement_shape 'full'
     (the same two writes admin-measurements.html makes; service_role passes
     claims_guard_measurement_shape).
  5. Prints every touched row BEFORE and AFTER and asserts the after-state.

WHAT IT NEVER DOES: call Stripe, call any Edge Function (so no send-measurement-ready
email), press the buy panel, touch contractor 986ce2b6, insert a bid, or write any row
other than the two named above. It only talks to PostgREST at SUPABASE_URL.
It does NOT prove: the admin page's own fulfilment path, a real vendor report, a real payment.

USAGE (gh-2582: a secret is never a command-line argument, a URL or printed output):
  The script accepts ONLY --execute and --ruling <digits>. The service-role key is loaded,
  in this order, from: (a) env SUPABASE_SERVICE_ROLE_KEY, (b) the file named by env
  SUPABASE_SERVICE_ROLE_KEY_FILE, (c) the Supabase Management API api-keys call, using env
  SUPABASE_ACCESS_TOKEN (Doppler otterquote/prd holds that token but no service-role key).
  Set the variable from a non-echoing source (a Doppler/secret-store read inside a shell
  variable, or a mode-600 file); never type a value on a command line.
    SUPABASE_URL=https://<ref>.supabase.co python3 scripts/gh1411-synthetic-e2e.py     # plan: GETs only
    SUPABASE_URL=... python3 scripts/gh1411-synthetic-e2e.py --execute --ruling 6050104990
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

CLAIM_ID = "73208937-a1c2-4db5-b402-3e7ec76374ae"
ORDER_PREFIX = "3b4622fb"
BUYER_CONTRACTOR_ID = "8fa0d121-d7e1-4064-8da3-c1bf6d83a4be"
RULING = "6050104990"
UPGRADE_PRODUCT_CODE = "roof_upgrade_detailed"
ORDER_COLS = "id,claim_id,product_code,status,report_url,measurements_json,fulfilled_at,requested_by_contractor_id"
CLAIM_COLS = "id,is_test,measurement_shape,live_charge_authorized_at,hover_measurements"


def synthetic_measurements(existing_squares, now_iso):
    """Squares is KEPT at the claim's existing figure so the D-317 tier does not move;
    every other number is synthetic and the object says so."""
    sq = float(existing_squares)
    area_sf = round(sq * 100, 2)
    return {
        "source": "synthetic_e2e_gh1411",
        "entered_at": now_iso,
        "entered_by": "cto-run-synthetic-e2e",
        "roof_area_sf": area_sf,
        "squares": sq,
        "ridge_hip_lf": 80.0, "valley_lf": 40.0, "rake_lf": 60.0, "eave_lf": 110.0,
        "drip_edge_perimeter_lf": 170.0, "step_flashing_lf": 25.0, "flashing_lf": 30.0,
        "predominant_pitch": "6/12", "high_roof_sq": 0,
        "areas_by_pitch": [{"pitch": "6/12", "area_sf": area_sf, "squares": sq, "pct": None}],
    }


def check_preconditions(order, claim, buyer):
    """Return a list of failure strings; empty means every precondition holds."""
    if not order:
        return ["order %s* not found" % ORDER_PREFIX]
    if not claim:
        return ["claim %s not found" % CLAIM_ID]
    bad = []
    if claim.get("id") != CLAIM_ID:
        bad.append("claim id mismatch")
    if claim.get("is_test") is not True:
        bad.append("claim.is_test is not true (%r)" % claim.get("is_test"))
    if not buyer or buyer.get("is_test") is not True:
        bad.append("buyer contractor is not is_test=true")
    if not str(order.get("id", "")).startswith(ORDER_PREFIX):
        bad.append("order id prefix mismatch")
    if order.get("claim_id") != CLAIM_ID:
        bad.append("order.claim_id != fixture claim")
    if order.get("requested_by_contractor_id") != BUYER_CONTRACTOR_ID:
        bad.append("order buyer is not contractor 8fa0d121")
    if order.get("product_code") != UPGRADE_PRODUCT_CODE:
        bad.append("order.product_code is %r" % order.get("product_code"))
    if order.get("status") != "awaiting_fulfillment":
        bad.append("order.status is %r, expected awaiting_fulfillment" % order.get("status"))
    if order.get("report_url") is not None or order.get("measurements_json") is not None or order.get("fulfilled_at") is not None:
        bad.append("order already carries a report / measurements / fulfilled_at")
    if claim.get("measurement_shape") is not None:
        bad.append("claim.measurement_shape already set (%r)" % claim.get("measurement_shape"))
    sq = (claim.get("hover_measurements") or {}).get("squares")
    try:
        float(sq)
    except (TypeError, ValueError):
        bad.append("claim.hover_measurements.squares missing (%r)" % (sq,))
    return bad


def build_steps(order, claim, now_iso):
    """Ordered writes: (label, table, filter, patch). The marker clear is first, by ruling."""
    m = synthetic_measurements((claim["hover_measurements"] or {})["squares"], now_iso)
    return [
        ("1 clear live_charge_authorized_at", "claims", {"id": CLAIM_ID}, {"live_charge_authorized_at": None}),
        ("2 deliver upgrade order", "hover_orders", {"id": order["id"]},
         {"measurements_json": m, "status": "completed", "fulfilled_at": now_iso, "updated_at": now_iso}),
        ("3 mirror to claim + flip shape", "claims", {"id": CLAIM_ID},
         {"hover_measurements": m, "measurement_shape": "full"}),
    ]


def check_after(order, claim):
    bad = []
    if claim.get("live_charge_authorized_at") is not None:
        bad.append("live_charge_authorized_at not NULL")
    if claim.get("measurement_shape") != "full":
        bad.append("measurement_shape != full")
    if order.get("status") != "completed" or not order.get("fulfilled_at"):
        bad.append("order not completed")
    if (order.get("measurements_json") or {}).get("source") != "synthetic_e2e_gh1411":
        bad.append("order measurements_json not the synthetic object")
    if (claim.get("hover_measurements") or {}).get("source") != "synthetic_e2e_gh1411":
        bad.append("claim.hover_measurements not the synthetic object")
    return bad


class Rest:
    def __init__(self, url, key, opener=urllib.request.urlopen):
        self.url, self.key, self.opener = url.rstrip("/"), key, opener

    def _call(self, method, path, body=None):
        req = urllib.request.Request(self.url + "/rest/v1/" + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"apikey": self.key, "Authorization": "Bearer " + self.key,
                                              "Content-Type": "application/json", "Prefer": "return=representation"})
        with self.opener(req, timeout=30) as r:
            return json.loads(r.read().decode() or "null")

    def get(self, table, cols, flt):
        q = "&".join("%s=eq.%s" % kv for kv in flt.items())
        return self._call("GET", "%s?select=%s&%s" % (table, cols, q))

    def patch(self, table, flt, patch):
        q = "&".join("%s=eq.%s" % kv for kv in flt.items())
        rows = self._call("PATCH", "%s?%s" % (table, q), patch)
        if not isinstance(rows, list) or len(rows) != 1:
            raise RuntimeError("PATCH %s matched %r rows, expected exactly 1" % (table, None if rows is None else len(rows)))
        return rows[0]


def bad_argv(argv):
    """gh-2582: only --execute and --ruling <digits> may appear on the command line.
    Anything else (a key, a token, KEY=value, a URL) is refused WITHOUT being echoed."""
    bad = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--execute":
            i += 1
        elif a == "--ruling" and i + 1 < len(argv) and argv[i + 1].isdigit():
            i += 2
        else:
            bad.append("argument #%d" % (i + 1))
            i += 1
    return bad


def load_service_key(environ, opener=urllib.request.urlopen):
    """Return the service-role key from env, then a file, then the Management API. Never prints it."""
    key = (environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if key:
        return key
    path = environ.get("SUPABASE_SERVICE_ROLE_KEY_FILE")
    if path:
        with open(path) as f:
            key = f.read().strip()
        if key:
            return key
    token, url = (environ.get("SUPABASE_ACCESS_TOKEN") or "").strip(), environ.get("SUPABASE_URL") or ""
    host = url.replace("https://", "").split("/")[0]
    ref = host.split(".")[0] if host.endswith(".supabase.co") else ""
    if token and ref:
        req = urllib.request.Request("https://api.supabase.com/v1/projects/%s/api-keys?reveal=true" % ref,
                                     headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        with opener(req, timeout=30) as r:
            for k in json.loads(r.read().decode() or "[]"):
                if k.get("name") == "service_role" and k.get("api_key"):
                    return k["api_key"]
    return None


def read_state(rest):
    orders = [o for o in rest.get("hover_orders", ORDER_COLS, {"claim_id": CLAIM_ID})
              if str(o.get("id", "")).startswith(ORDER_PREFIX)]
    claims = rest.get("claims", CLAIM_COLS, {"id": CLAIM_ID})
    buyers = rest.get("contractors", "id,is_test", {"id": BUYER_CONTRACTOR_ID})
    return (orders[0] if len(orders) == 1 else None, claims[0] if claims else None, buyers[0] if buyers else None)


def run(rest, execute, ruling, now_iso, out=print):
    order, claim, buyer = read_state(rest)
    out("BEFORE order : " + json.dumps(order, sort_keys=True))
    out("BEFORE claim : " + json.dumps(claim, sort_keys=True))
    out("BEFORE buyer : " + json.dumps(buyer, sort_keys=True))
    bad = check_preconditions(order, claim, buyer)
    if bad:
        out("PRECONDITIONS FAILED, no write made: " + "; ".join(bad))
        return 2
    out("PRECONDITIONS OK (claim, buyer, order all is_test fixtures in the expected state)")
    steps = build_steps(order, claim, now_iso)
    for label, table, flt, patch in steps:
        out("PLAN %s -> %s %s %s" % (label, table, json.dumps(flt), json.dumps(patch, sort_keys=True)))
    if not execute:
        out("PLAN ONLY (no --execute): no write made")
        return 0
    if ruling != RULING:
        out("REFUSED: --execute needs --ruling %s (CEO ruling on #1411); no write made" % RULING)
        return 3
    for label, table, flt, patch in steps:
        row = rest.patch(table, flt, patch)
        out("DONE %s (1 row %s)" % (label, row.get("id")))
    order2, claim2, _ = read_state(rest)
    out("AFTER order  : " + json.dumps(order2, sort_keys=True))
    out("AFTER claim  : " + json.dumps(claim2, sort_keys=True))
    bad = check_after(order2, claim2)
    if bad:
        out("AFTER-STATE CHECK FAILED: " + "; ".join(bad))
        return 4
    out("AFTER-STATE CHECK OK: marker NULL, shape full, order completed, synthetic objects in place")
    return 0


def main(argv):
    bad = bad_argv(argv)
    if bad:
        print("REFUSED: unexpected command-line " + ", ".join(bad) + " (values not shown). Secrets come from the environment only (gh-2582).")
        return 1
    execute = "--execute" in argv
    ruling = argv[argv.index("--ruling") + 1] if "--ruling" in argv and argv.index("--ruling") + 1 < len(argv) else None
    url = os.environ.get("SUPABASE_URL")
    try:
        key = load_service_key(os.environ) if url else None
    except Exception as e:
        print("could not load the service-role key (%s; no value shown)" % type(e).__name__)
        return 1
    if not url or not key:
        print("SUPABASE_URL and a service-role key source are required: env SUPABASE_SERVICE_ROLE_KEY, "
              "env SUPABASE_SERVICE_ROLE_KEY_FILE, or env SUPABASE_ACCESS_TOKEN (never printed)")
        return 1
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return run(Rest(url, key), execute, ruling, now_iso)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

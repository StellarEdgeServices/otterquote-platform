// gh-2154: structural + rule test for 20261019224248_gh2154_internal_test_email_add_otterquote_com.
// Run: node tests/gh2154-otterquote-com-test-domain.mjs   (exit 0 = PASS)
// It parses the domain IN-list out of the forward migration and evaluates it in JS with the same
// split_part(lower(btrim(email)),'@',2) semantics. Negative control: the same parse of the previous
// migration (gh-2310 Gap 2) must REJECT otterquote.com, proving the test can fail.
import { readFileSync } from "node:fs";

const STEM = "20261019224248_gh2154_internal_test_email_add_otterquote_com";
const FWD = `supabase/migrations/${STEM}.sql`;
const RB = `supabase/migrations_rollbacks/${STEM}_rollback.sql`;
const PRE = `supabase/migrations/${STEM}_pre-flight.md`;
const PROOF = "supabase/tests/gh2154_otterquote_com_test_domain_proof.sql";
const PREV = "supabase/migrations/20261003014844_gh2310_gap2_referral_agents_internal_test_trigger.sql";

const code = (s) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

function domains(sqlText) {
  const m = code(sqlText).match(/split_part\(lower\(btrim\(p_email\)\), '@', 2\) IN \(([^)]*)\)/);
  if (!m) throw new Error("domain IN-list not found");
  return m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
}
const rule = (list) => (email) => list.includes((email.trim().toLowerCase().split("@")[1] ?? ""));

const fwd = readFileSync(FWD, "utf8"), rb = readFileSync(RB, "utf8"), prev = readFileSync(PREV, "utf8");
for (const p of [PRE, PROOF]) ok(readFileSync(p, "utf8").length > 0, `exists ${p}`);

const newList = domains(fwd), oldList = domains(prev), rbList = domains(rb);
ok(JSON.stringify(newList) === JSON.stringify([...oldList, "otterquote.com"]), `forward list = previous + otterquote.com only (${newList.join(",")})`);
ok(JSON.stringify(rbList) === JSON.stringify(oldList), "rollback restores the previous list exactly");

const isNew = rule(newList), isOld = rule(oldList);
for (const e of ["sloane+walk1@otterquote.com", "Sloane@OtterQuote.com", " sloane+walk0@otterquote.com "]) ok(isNew(e) === true, `new rule accepts ${e.trim()}`);
for (const e of ["x@otterquote.com.evil.io", "x@nototterquote.com", "x@otterquotes.com", "x@example.com", "otterquote.com@example.com"]) ok(isNew(e) === false, `new rule rejects ${e}`);
for (const d of oldList) ok(isNew(`x@${d}`) === true, `existing domain kept: ${d}`);

// Negative control: the previous rule must reject the walk address (the defect this PR fixes).
ok(isOld("sloane+walk1@otterquote.com") === false, "NEGATIVE CONTROL: previous rule rejects sloane+walk1@otterquote.com");

const c = code(fwd);
ok(/IN \('dustinstohler1',\s*%L\)/.test(c), "gmail base list unchanged: ('dustinstohler1', %L)");
ok(c.includes("0a934e11-5cac-4607-a63c-7446fe446f81") && (c.match(/RAISE EXCEPTION/g) ?? []).length >= 8, "Stacy re-derived at apply time, fail-closed RAISEs present");
ok(!/[A-Za-z0-9._%+-]+@gmail\.com/i.test(fwd + rb + readFileSync(PROOF, "utf8")), "no gmail address literal in repo files");
ok(/REVOKE ALL ON FUNCTION public\.is_internal_test_email\(text\) FROM PUBLIC, anon, authenticated/.test(c) && !/\bGRANT\b/.test(c), "privileges revoked, no GRANT");
ok(!/\b(UPDATE|DELETE)\b/.test(c.replace(/CREATE OR REPLACE/g, "")) && !/INSERT INTO/.test(c), "forward migration touches no data");
const pr = code(readFileSync(PROOF, "utf8"));
ok(/^\s*BEGIN;/m.test(pr) && /^\s*ROLLBACK;/m.test(pr) && !/^\s*COMMIT;/m.test(pr), "proof is BEGIN..ROLLBACK, never COMMIT");
ok(/DISABLE TRIGGER referral_agents_set_is_test_internal/.test(pr) && /DISABLE TRIGGER trg_notify_admin_new_partner/.test(pr), "proof has negative control and disables the alert trigger");

console.log(fails ? `RESULT: FAIL (${fails})` : "RESULT: PASS");
process.exit(fails ? 1 : 0);

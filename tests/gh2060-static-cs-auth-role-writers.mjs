/**
 * gh-2060 RETURNED round 2 (5856979653), item 1 — static-stack WRITER
 * negative control.
 *
 * `tests/gh2060-static-cs-auth-role-staleness.mjs` proves the js/auth.js
 * READER (`Auth.handleAuthCallback()`) fails closed when `cs_auth_role_at`
 * is missing or stale. It does that by seeding `localStorage` directly —
 * it never executes any of the 16 static WRITE call-sites across the 12
 * login/signup pages, so it cannot catch a regression where one of those
 * writers stops stamping `cs_auth_role_at` while still writing
 * `cs_auth_role`. The round-2 reviewer's own repro (5856970831) proved
 * exactly this gap: deleting all 16 static writes was silent under every
 * test that existed at the time.
 *
 * This test enumerates the 16 write sites by literal grep (raw output
 * pasted below, and reproduced live by this file itself so a future write
 * added or removed without updating this file's hard-coded `EXPECTED`
 * counts also turns this red), then asserts -- for every occurrence -- that
 * the very next line in the same file stamps `cs_auth_role_at`. A source
 * scan, not a live page execution: these are 12 different login/signup
 * pages with heavy DOM/Supabase dependencies, and the property being
 * guarded (“every cs_auth_role write is immediately followed by a
 * cs_auth_role_at write”) is a structural one that a source scan verifies
 * directly, the same style already used by this repo for
 * `tests/auth-cs-redirect-role-guard.mjs`'s Section B
 * (CONTRACTOR_GATED_FILES re-derivation).
 *
 * Grep command + raw output (react-app is not in scope here -- see
 * tests/gh2060-*.mjs for the React writer coverage):
 *
 *   $ grep -n "setItem('cs_auth_role'" login.html contractor-login.html \
 *       contractor-join.html hi-1.html ins-1.html re-1.html \
 *       partner-login.html partner-adjusters.html partner-inspectors.html \
 *       partner-insurance.html partner-other.html partner-re.html
 *   login.html:594:        localStorage.setItem('cs_auth_role', 'homeowner');
 *   login.html:623:    localStorage.setItem('cs_auth_role', 'homeowner');
 *   contractor-login.html:392:    localStorage.setItem('cs_auth_role', 'contractor');
 *   contractor-login.html:424:      localStorage.setItem('cs_auth_role', 'contractor');
 *   contractor-join.html:405:                localStorage.setItem('cs_auth_role', 'contractor');
 *   contractor-join.html:472:                localStorage.setItem('cs_auth_role', 'contractor');
 *   hi-1.html:1468:                localStorage.setItem('cs_auth_role', agentType);
 *   ins-1.html:1494:                localStorage.setItem('cs_auth_role', agentType);
 *   re-1.html:1120:      localStorage.setItem('cs_auth_role', agentType);
 *   partner-login.html:324:    localStorage.setItem('cs_auth_role', PARTNER_ROLE);
 *   partner-adjusters.html:1310:    localStorage.setItem('cs_auth_role', agentType);
 *   partner-inspectors.html:1268:    localStorage.setItem('cs_auth_role', agentType);
 *   partner-insurance.html:1330:                localStorage.setItem('cs_auth_role', agentType);
 *   partner-insurance.html:1605:                localStorage.setItem('cs_auth_role', agentType);
 *   partner-other.html:1290:    localStorage.setItem('cs_auth_role', agentType);
 *   partner-re.html:1630:      localStorage.setItem('cs_auth_role', agentType);
 *   (16 lines -- 16 write sites across the 12 files.)
 *
 * NEGATIVE CONTROL (pasted in the PR/HANDOFF-LIVE, reproduced against this
 * repo's actual working tree, then reverted):
 *   RED (all 16 `cs_auth_role_at` lines deleted):
 *     sed -i "/localStorage.setItem('cs_auth_role_at'/d" login.html contractor-login.html \
 *       contractor-join.html hi-1.html ins-1.html re-1.html partner-login.html \
 *       partner-adjusters.html partner-inspectors.html partner-insurance.html \
 *       partner-other.html partner-re.html
 *     node tests/gh2060-static-cs-auth-role-writers.mjs   -> 16 case(s) failed.
 *   RED (a single one deleted, e.g. login.html's first site):
 *     sed -i '595d' login.html   (the cs_auth_role_at line immediately after :594)
 *     node tests/gh2060-static-cs-auth-role-writers.mjs   -> 1 case failed (login.html #1).
 *   GREEN (reverted): all cases pass.
 *
 * Run: node tests/gh2060-static-cs-auth-role-writers.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Hard-coded from the grep enumeration above -- a write added or removed
// without updating this map turns the file-count check red too, not just
// the per-site adjacency check.
const EXPECTED_WRITE_COUNTS = {
  'login.html': 2,
  'contractor-login.html': 2,
  'contractor-join.html': 2,
  'hi-1.html': 1,
  'ins-1.html': 1,
  're-1.html': 1,
  'partner-login.html': 1,
  'partner-adjusters.html': 1,
  'partner-inspectors.html': 1,
  'partner-insurance.html': 2,
  'partner-other.html': 1,
  'partner-re.html': 1,
};
const EXPECTED_TOTAL = 16;

const ROLE_RE = /localStorage\.setItem\(\s*['"]cs_auth_role['"]\s*,/;
const ROLE_AT_RE = /localStorage\.setItem\(\s*['"]cs_auth_role_at['"]\s*,/;

let failures = 0;
let totalFound = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`✗ FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

function main() {
  for (const [file, expectedCount] of Object.entries(EXPECTED_WRITE_COUNTS)) {
    const fullPath = path.join(REPO_ROOT, file);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');

    const writeLineNumbers = [];
    lines.forEach((line, idx) => {
      if (ROLE_RE.test(line)) writeLineNumbers.push(idx); // 0-based
    });

    check(
      `${file}: exactly ${expectedCount} cs_auth_role write site(s) (found ${writeLineNumbers.length})`,
      () => {
        if (writeLineNumbers.length !== expectedCount) {
          throw new Error(
            `expected ${expectedCount} cs_auth_role write site(s) in ${file}, found ${writeLineNumbers.length} ` +
            `at line(s) ${writeLineNumbers.map((i) => i + 1).join(', ')} -- a write was added or removed`
          );
        }
      }
    );
    totalFound += writeLineNumbers.length;

    writeLineNumbers.forEach((idx, siteNum) => {
      const nextLine = lines[idx + 1] ?? '';
      check(
        `${file} #${siteNum + 1} (line ${idx + 1}): cs_auth_role write is immediately followed by a cs_auth_role_at stamp`,
        () => {
          if (!ROLE_AT_RE.test(nextLine)) {
            throw new Error(
              `line ${idx + 2} of ${file} does not stamp cs_auth_role_at (got: ${JSON.stringify(nextLine.trim())}) -- ` +
              `/auth-callback's TTL guard (and index.html's bounce) will treat this writer's value as ` +
              `permanently absent-of-timestamp, i.e. always stale, the moment this stamp is deleted`
            );
          }
        }
      );
    });
  }

  check(`total cs_auth_role write sites across all 12 files == ${EXPECTED_TOTAL}`, () => {
    if (totalFound !== EXPECTED_TOTAL) {
      throw new Error(`expected ${EXPECTED_TOTAL} total write sites, found ${totalFound}`);
    }
  });

  if (failures > 0) {
    console.log(`\n✗ ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ All gh-2060 static-stack cs_auth_role WRITER cases pass (${totalFound} write sites, 12 files).`);
  process.exit(0);
}

main();

/**
 * gh-2060 RETURNED round 2 (5856979653), item 1 — static-stack WRITER
 * negative control.
 *
 * `tests/gh2060-static-cs-auth-role-staleness.mjs` proves the js/auth.js
 * READER (`Auth.handleAuthCallback()`) fails closed when `cs_auth_role_at`
 * is missing or stale. It does that by seeding `localStorage` directly —
 * it never executes any of the static WRITE call-sites across the
 * login/signup pages, so it cannot catch a regression where one of those
 * writers stops stamping `cs_auth_role_at` while still writing
 * `cs_auth_role`. The round-2 reviewer's own repro (5856970831) proved
 * exactly this gap: deleting all 16 (then-known) static writes was silent
 * under every test that existed at the time.
 *
 * RETURNED round 3 (5869018861): the original version of this file used a
 * hard-coded 12-file list plus a fixed `EXPECTED_TOTAL === 16` check. When
 * `main` moved 79 commits ahead and 6 new funnel pages (hi-4.html,
 * hi-5.html, ins-3.html, ins-5.html, re-3.html, re-5.html) each added a
 * `cs_auth_role` write without a matching `cs_auth_role_at` stamp, this
 * test could not see them at all -- it never looked at those files, and
 * the fixed-total assertion has no way to notice a write site it never
 * counted. Per round-3 item 2, this version discovers every writer by
 * scanning every root `*.html` file and every `js/*.js` file, keeps the
 * per-site adjacency check, and replaces the fixed total with "every write
 * site found (whatever the count) is stamped" -- so a future page that
 * adds a `cs_auth_role` write without a `cs_auth_role_at` stamp fails this
 * test immediately, instead of being invisible to it.
 *
 * Grep command + raw output, reproduced live by this file itself:
 *
 *   $ grep -rn "setItem('cs_auth_role'" --include=*.html . | grep -v node_modules
 *   $ grep -n "setItem('cs_auth_role'" js/*.js
 *
 * (See the round-3 review comment and the Q comment on issue #2060 for the
 * full enumeration at the merge-base used to fix this PR.)
 *
 * Run: node tests/gh2060-static-cs-auth-role-writers.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const ROLE_RE = /localStorage\.setItem\(\s*['"]cs_auth_role['"]\s*,/;
const ROLE_AT_RE = /localStorage\.setItem\(\s*['"]cs_auth_role_at['"]\s*,/;

let failures = 0;
let totalFound = 0;
let filesWithWrites = 0;

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

// Discover writer files: every root-level *.html file, plus every js/*.js
// file -- no hard-coded list, so a new page/file is picked up automatically.
function discoverCandidateFiles() {
  const rootHtml = fs
    .readdirSync(REPO_ROOT)
    .filter((name) => name.endsWith('.html'))
    .filter((name) => fs.statSync(path.join(REPO_ROOT, name)).isFile())
    .sort();

  const jsDir = path.join(REPO_ROOT, 'js');
  const jsFiles = fs
    .readdirSync(jsDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => fs.statSync(path.join(jsDir, name)).isFile())
    .map((name) => path.join('js', name))
    .sort();

  return [...rootHtml, ...jsFiles];
}

function main() {
  const candidateFiles = discoverCandidateFiles();

  for (const file of candidateFiles) {
    const fullPath = path.join(REPO_ROOT, file);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');

    const writeLineNumbers = [];
    lines.forEach((line, idx) => {
      if (ROLE_RE.test(line)) writeLineNumbers.push(idx); // 0-based
    });

    if (writeLineNumbers.length === 0) continue;

    filesWithWrites += 1;
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

  check(
    `every discovered cs_auth_role write site is stamped (${totalFound} site(s) across ${filesWithWrites} file(s), ${candidateFiles.length} file(s) scanned)`,
    () => {
      if (totalFound === 0) {
        throw new Error('found 0 cs_auth_role write sites -- discovery is broken (expected > 0)');
      }
      // The per-site checks above already fail individually on any
      // unstamped write; this final check exists so a silent discovery
      // regression (e.g. the root/js scan finding nothing) cannot pass by
      // vacuous truth. Failures already counted in the per-site loop above
      // are what actually turns this test red -- this assertion is a floor.
    }
  );

  if (failures > 0) {
    console.log(`\n✗ ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ All gh-2060 static-stack cs_auth_role WRITER cases pass (${totalFound} write sites across ${filesWithWrites} files, ${candidateFiles.length} files scanned).`);
  process.exit(0);
}

main();

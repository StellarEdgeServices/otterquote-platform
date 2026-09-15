/**
 * gh-1939 R-1 regression test (CEO RUN 47 ruling, refuter report
 * ceo47-review-pr1958-20260915.md).
 *
 * GA4Gate.tsx's stop-on-navigation fix (stopClarity + the counter-poll --
 * see that file's comments) is measured best-effort, not a guarantee: it
 * was proven against Clarity 0.8.69's actual SPA-navigation auto-restart
 * in a real browser (react-app/spa-nav-test.mjs, run manually, not part of
 * this suite), not against a future Clarity build. The real backstop for
 * D-322 ("Clarity never on an authenticated surface") is that
 * CLARITY_ALLOWED_PATHS stays exactly `["/get-started"]` and that nothing
 * in this app ever performs a client-side (router.push/router.replace/
 * <Link>) navigation either (a) out of app/get-started/* to another
 * internal route, or (b) anywhere in the app, toward /get-started -- i.e.
 * the reachability gap the refuter's report measured (R-1: "no current
 * code path reaches this, but nothing stops one from being added") never
 * gets reopened silently.
 *
 * This test:
 *   (i)  pins CLARITY_ALLOWED_PATHS to exactly ["/get-started"] so a
 *        future widen-the-allowlist edit is a reviewed, visible diff here
 *        too, not just in GA4Gate.tsx;
 *   (ii) statically scans every react-app/app/**\/*.tsx file for a
 *        router.push(...)/router.replace(...)/<Link href=...> whose
 *        target is an internal route starting with "/get-started", or
 *        that lives inside app/get-started/ and targets any other
 *        internal route -- either shape would let Clarity survive a
 *        client-side navigation into/out of the allowed funnel, which is
 *        exactly the mechanism R-1 measured. A hit fails with file:line.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// GA4Gate.tsx does not export CLARITY_ALLOWED_PATHS (it is a private module
// constant, deliberately -- the gate is the only writer). Re-read it from
// source text via a regex rather than widen GA4Gate's public surface just
// for this test.
const GA4_GATE_PATH = path.resolve(__dirname, "../GA4Gate.tsx");
const APP_ROOT = path.resolve(__dirname, "../../"); // react-app/app

function readGA4GateSource(): string {
  return fs.readFileSync(GA4_GATE_PATH, "utf8");
}

function extractClarityAllowedPaths(source: string): string[] {
  const m = source.match(/CLARITY_ALLOWED_PATHS\s*=\s*\[([^\]]*)\]/);
  if (!m) {
    throw new Error("CLARITY_ALLOWED_PATHS not found in GA4Gate.tsx -- has it been renamed?");
  }
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map(mm => mm[1]);
}

function walkTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === "__tests__" ||
      entry.name === "tests" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsxFiles(full));
    } else if (
      entry.isFile() &&
      (full.endsWith(".tsx") || full.endsWith(".ts")) &&
      !/\.test\.(ts|tsx)$/.test(full)
    ) {
      // Scan real app source only -- this file's own synthetic fixtures
      // (below) deliberately contain the strings the scanner looks for,
      // and would otherwise self-flag.
      out.push(full);
    }
  }
  return out;
}

interface NavHit {
  file: string;
  line: number;
  kind: string;
  target: string;
}

const NAV_CALL_RE = /\b(router\.push|router\.replace)\(\s*[`'"]([^`'"]+)[`'"]/g;
const LINK_HREF_RE = /<Link\b[^>]*\bhref\s*=\s*\{?[`'"]([^`'"]+)[`'"]/g;

function isInternalRoute(target: string): boolean {
  // "internal route" = an in-app path, not an absolute/external URL, a
  // mailto:/tel: link, or a bare hash/query fragment with no path.
  if (!target.startsWith("/")) return false;
  if (target.startsWith("//")) return false; // protocol-relative external
  return true;
}

function findNavHits(files: string[]): NavHit[] {
  const hits: NavHit[] = [];
  for (const file of files) {
    const rel = path.relative(APP_ROOT, file);
    const source = fs.readFileSync(file, "utf8");
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") lineStarts.push(i + 1);
    }
    const lineOf = (idx: number) => {
      // binary search would be overkill for these file sizes; linear is fine
      let line = 1;
      for (let i = 0; i < lineStarts.length; i++) {
        if (lineStarts[i] <= idx) line = i + 1;
        else break;
      }
      return line;
    };

    const isUnderGetStarted = rel.split(path.sep).includes("get-started");

    for (const [re, kind, targetGroup] of [
      [NAV_CALL_RE, "router-nav", 2] as const,
      [LINK_HREF_RE, "link-href", 1] as const,
    ]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const capturedTarget = match[targetGroup];
        if (!isInternalRoute(capturedTarget)) continue;

        const targetsGetStarted = capturedTarget.startsWith("/get-started");
        const leavesGetStarted = isUnderGetStarted;

        if (targetsGetStarted || leavesGetStarted) {
          hits.push({
            file: rel,
            line: lineOf(match.index),
            kind,
            target: capturedTarget,
          });
        }
      }
    }
  }
  return hits;
}

describe("gh-1939 R-1: Clarity route-guard regression", () => {
  it("CLARITY_ALLOWED_PATHS is exactly ['/get-started']", () => {
    const paths = extractClarityAllowedPaths(readGA4GateSource());
    expect(paths).toEqual(["/get-started"]);
  });

  it("no client-side navigation targets /get-started, and nothing inside app/get-started/ client-side-navigates to another internal route", () => {
    const files = walkTsxFiles(APP_ROOT);
    const hits = findNavHits(files);

    if (hits.length > 0) {
      const report = hits.map(h => `${h.file}:${h.line} (${h.kind} -> "${h.target}")`).join("\n");
      throw new Error(
        "gh-1939 R-1 regression: found a client-side navigation that would let " +
          "Microsoft Clarity survive a route change (see GA4Gate.tsx's stopClarity " +
          "docstring -- the JS-level stop is best-effort, the real backstop is that " +
          "no such navigation exists):\n" +
          report
      );
    }
    expect(hits).toEqual([]);
  });
});

// Belt-and-suspenders sanity check on the scanner itself: not exercised
// against real repo files above, so prove the regex logic actually catches
// what it claims to on synthetic input (a scanner with no positive test is
// a scanner nobody has verified fires).
describe("gh-1939 R-1: scanner self-test (synthetic fixtures, not real files)", () => {
  it("flags router.push targeting /get-started from an arbitrary file", () => {
    const source = `
      function go() {
        router.push('/get-started');
      }
    `;
    const hits: NavHit[] = [];
    NAV_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAV_CALL_RE.exec(source)) !== null) {
      if (isInternalRoute(m[2]) && m[2].startsWith("/get-started")) {
        hits.push({ file: "synthetic.tsx", line: 1, kind: "router-nav", target: m[2] });
      }
    }
    expect(hits.length).toBe(1);
  });

  it("flags router.push('/dashboard') from inside a get-started/ path", () => {
    const source = `router.push('/dashboard');`;
    const rel = "get-started/page.tsx";
    const isUnderGetStarted = rel.split("/").includes("get-started");
    NAV_CALL_RE.lastIndex = 0;
    const m = NAV_CALL_RE.exec(source);
    expect(m).not.toBeNull();
    expect(isUnderGetStarted && isInternalRoute(m![2])).toBe(true);
  });

  it("does not flag an absolute external URL or a plain otterquote.com anchor", () => {
    expect(isInternalRoute("https://otterquote.com/dashboard")).toBe(false);
    expect(isInternalRoute("//otterquote.com/dashboard")).toBe(false);
  });
});

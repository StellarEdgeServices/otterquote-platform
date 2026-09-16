/**
 * gh-2000 regression test.
 *
 * Root cause (issue #2000, comment 5701924287): both Meta Pixel gates
 * (js/meta-pixel-gate.js for the static HTML pages, MetaPixelGate.tsx for
 * the React app) defined fbq as a stub that ALWAYS pushes onto a queue:
 *
 *   window.fbq = window.fbq || function () {
 *     (window.fbq.queue = window.fbq.queue || []).push(arguments);
 *   };
 *
 * Meta's own base snippet stub instead checks for a `callMethod` that
 * fbevents.js installs once it loads, and forwards live calls to it:
 *
 *   n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)
 *
 * Our stub never checked for callMethod, so once fbevents.js loaded and
 * drained the queue it found at load time (giving `init` + `PageView`,
 * fired synchronously before the script tag is even appended), every
 * later fbq() call -- including `fbq('track', 'Lead')` on submit -- was
 * pushed into the queue array and never read again. No further beacon
 * (Lead, ViewContent, any trackCustom) reached Meta's servers.
 *
 * This test loads each file's real stub-definition source verbatim (not a
 * re-implementation) into a sandbox, simulates fbevents.js installing
 * `callMethod` on the resulting fbq object (mirroring what fbevents.js
 * does on load), and asserts a POST-LOAD `fbq('track','Lead')` call
 * reaches `callMethod`. It fails against the pre-fix stub (the call is
 * only ever queued, callMethod is never invoked) and passes once the
 * stub is Meta's standard callMethod-forwarding form.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const STATIC_GATE_PATH = path.join(REPO_ROOT, "js/meta-pixel-gate.js");
const REACT_GATE_PATH = path.resolve(__dirname, "../MetaPixelGate.tsx");

/**
 * Slices `src` between two literal anchors (both required to be present,
 * in order). Used instead of a single shape-specific regex so this same
 * test file can extract the stub both from the pre-fix source (a plain
 * queue-push stub) and the post-fix source (the callMethod-forwarding
 * stub) -- both revisions keep the surrounding anchor text unchanged.
 */
function extractBetween(src: string, startMarker: string, endMarker: string, file: string): string {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Could not find "${startMarker}" in ${file} -- has it moved/changed?`);
  }
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) {
    throw new Error(`Could not find "${endMarker}" after the stub in ${file} -- has it moved/changed?`);
  }
  return src.slice(startIdx, endIdx);
}

function readStaticGateStubSource(): string {
  const src = fs.readFileSync(STATIC_GATE_PATH, "utf8");
  // Anchors unchanged by the gh-2000 fix: the comment immediately above
  // the stub, and the `if (!PIXEL_ID)` check immediately below it.
  return extractBetween(
    src,
    "// fbq is defined unconditionally so every page's existing",
    "if (!PIXEL_ID) {",
    "js/meta-pixel-gate.js"
  );
}

function readReactGateStubSource(): string {
  const src = fs.readFileSync(REACT_GATE_PATH, "utf8");
  // Anchors unchanged by the gh-2000 fix: the start of the inline
  // <Script id="meta-pixel-init"> template literal, and the fbq('init', ...)
  // call that always immediately follows the stub definition.
  const block = extractBetween(src, "{`", "\nfbq('init'", "MetaPixelGate.tsx");
  return block.slice(2); // drop the leading "{`" (not JS source)
}

/**
 * Runs `stubSource` (a `window.fbq = ...;` assignment statement) against a
 * fake `window`, then simulates fbevents.js's real load-time behaviour:
 * drain whatever was queued synchronously (this is what makes `init` +
 * `PageView` work today), then install `callMethod` on the fbq object --
 * exactly as fbevents.js does once it finishes loading. A call made AFTER
 * that point is the `Lead` case: it happens long after page load, on
 * user-submit.
 */
function runStubAgainstFakeFbevents(stubSource: string) {
  const callMethodCalls: unknown[][] = [];
  const sandboxWindow: any = {};

  // eslint-disable-next-line no-new-func
  const install = new Function("window", `${stubSource}\nreturn window.fbq;`);
  const fbq = install(sandboxWindow);

  // Pre-load calls (init/PageView), matching both gates' real call order.
  fbq("init", "800470107451795");
  fbq("track", "PageView");

  // fbevents.js load completes: it drains whatever is in the queue at that
  // instant (the two calls above) and installs callMethod for anything
  // called afterward. We don't need to model the drain itself (that part
  // already works, per the live evidence on #2000) -- only that
  // `callMethod` now exists on the same fbq object callers keep using.
  sandboxWindow.fbq.callMethod = function (...args: unknown[]) {
    callMethodCalls.push(args);
  };

  // Post-load call: this is the Lead-on-submit case.
  fbq("track", "Lead");

  return { callMethodCalls, queueAfter: sandboxWindow.fbq.queue };
}

describe("gh-2000: Meta Pixel gate stub forwards to fbevents' callMethod", () => {
  it("static gate (js/meta-pixel-gate.js): post-load fbq('track','Lead') reaches callMethod", () => {
    const stubSource = readStaticGateStubSource();
    const { callMethodCalls } = runStubAgainstFakeFbevents(stubSource);
    expect(callMethodCalls).toContainEqual(["track", "Lead"]);
  });

  it("React gate (MetaPixelGate.tsx): post-load fbq('track','Lead') reaches callMethod", () => {
    const stubSource = readReactGateStubSource();
    const { callMethodCalls } = runStubAgainstFakeFbevents(stubSource);
    expect(callMethodCalls).toContainEqual(["track", "Lead"]);
  });
});

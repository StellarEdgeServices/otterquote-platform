// D-274 (#631) — BoldSign sandbox/live integration test.
//
// Convention note: this is a Deno test (matches how the Edge Functions
// themselves and their unit tests — payload-parser.test.ts, ack-verify.test.ts
// — are authored and run), NOT a Playwright spec like the other files in
// tests/e2e/flows/. Run with:
//   BOLDSIGN_INTEGRATION_ENABLED=true BOLDSIGN_API=<key> \
//     deno test --allow-net --allow-env tests/e2e/helpers/boldsign-integration.test.ts
//
// GATED, same principle as docusign-artifacts.ts's DOCUSIGN_E2E_ENABLED:
// disabled by default, MUST NOT run in CI, and must never be enabled without
// explicit, current authorization for a real send (see the D-274 safety rail
// on issue #631 — this test's only permitted recipient is Dustin's own
// verified address; it must never touch a synthetic or third-party email).
//
// ── What this actually verifies ──────────────────────────────────────────
// Confirms, against the REAL BoldSign API (not a mock):
//   1. BOLDSIGN_API authenticates (GET /v1/senderIdentities/list).
//   2. POST /v1/document/send succeeds with a Text-Tag-bearing PDF and
//      useTextTags:true, returning a documentId.
//   3. GET /v1/document/getEmbeddedSignLink returns a usable signLink for
//      that documentId + the signer's email.
//   4. GET /v1/document/properties returns signerDetails[] whose shape
//      matches what ack-verify.ts's evaluateAcknowledgment() expects.
//
// ── KNOWN FINDING (2026-08-13, D-274 build session) — READ BEFORE ENABLING ──
// A manual live run against the production BOLDSIGN_API key (via a temporary
// diagnostic Edge Function, since deleted per the build report) found: step 2
// (send) succeeds and returns a real documentId, but steps 3 and 4
// immediately fail with HTTP 403 "Forbidden" using the SAME key that created
// the document — and GET /v1/document/list shows zero total documents even
// right after a successful send. The correct query parameter name
// (`documentId`) was independently confirmed (a wrong param name returns a
// distinct 400 validation error, not 403), so this is not a client-side
// mistake in this test. This looks like a BoldSign-account-side issue
// (multi-team/sender-identity scoping, or an unusually long replication
// delay) that requires BoldSign support or Dustin's own dashboard access to
// diagnose — NOT something fixable by changing this test's code. If this
// test is run and step 3/4 fail with 403, do not assume the integration
// code is broken; check the BoldSign dashboard directly for the documentId
// printed in the failure output first.
//
// isSandbox:true was ALSO tried during that manual run and did not help —
// it produced the same 403 pattern, confirming (per the separate research
// finding) that BoldSign's sandbox/live distinction is credential-scoped,
// not a per-request flag usable on a production key.

// Lazy env reads throughout this file (not module-scope constants) so simply
// IMPORTING/type-checking it never requires --allow-env — only actually
// running the gated tests does.
function isEnabled(): boolean {
  try {
    return Deno.env.get("BOLDSIGN_INTEGRATION_ENABLED") === "true";
  } catch {
    return false; // no --allow-env at all -> definitely not enabled
  }
}

const TEST_RECIPIENT = "dustin@tryotterquote.com";
function getBoldSignApiBase(): string {
  return Deno.env.get("BOLDSIGN_API_BASE") || "https://api.boldsign.com";
}

function getBoldSignApiKey(): string {
  const key = Deno.env.get("BOLDSIGN_API");
  if (!key) throw new Error("BOLDSIGN_API not configured — required when BOLDSIGN_INTEGRATION_ENABLED=true.");
  return key;
}

function buildTestPdfBase64(): string {
  function esc(s: string) {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  const content: string[] = [];
  function text(x: number, y: number, size: number, s: string) {
    content.push(`BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`);
  }
  text(50, 750, 16, "OTTERQUOTE / BOLDSIGN INTEGRATION TEST");
  text(50, 725, 11, "THIS IS NOT A REAL CONTRACT.");
  text(50, 670, 10, "{{text|1|*|Test Text|test_text}}");
  text(50, 645, 10, "{{sign|1|*|Test Signature|test_signature}}");
  text(50, 620, 10, "{{init|1|*|Test Initial|test_initial}}");
  text(50, 595, 10, "{{date|1|*|Test Date|test_date}}");
  const stream = content.join("\n");
  const pdfLines: string[] = [];
  const pdfObjs: number[] = [];
  let byteOffset = 0;
  function pw(s: string) {
    pdfLines.push(s);
    byteOffset += s.length + 1;
  }
  function pso(n: number) {
    pdfObjs[n] = byteOffset;
    pw(`${n} 0 obj`);
  }
  pw("%PDF-1.4");
  pso(1);
  pw("<< /Type /Catalog /Pages 2 0 R >>");
  pw("endobj");
  pso(2);
  pw("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pw("endobj");
  pso(3);
  pw("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  pw("endobj");
  pso(4);
  pw(`<< /Length ${stream.length} >>`);
  pw("stream");
  pw(stream);
  pw("endstream");
  pw("endobj");
  pso(5);
  pw("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pw("endobj");
  const xrefOffset = byteOffset;
  pw("xref");
  pw("0 6");
  pw("0000000000 65535 f ");
  for (let i = 1; i <= 5; i++) pw(String(pdfObjs[i]).padStart(10, "0") + " 00000 n ");
  pw("trailer");
  pw("<< /Size 6 /Root 1 0 R >>");
  pw("startxref");
  pw(String(xrefOffset));
  pw("%%EOF");
  const bytes = new TextEncoder().encode(pdfLines.join("\n"));
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.test({
  name: "[gated] BOLDSIGN_API authenticates",
  ignore: !isEnabled(),
  fn: async () => {
    const res = await fetch(`${getBoldSignApiBase()}/v1/senderIdentities/list`, {
      headers: { "X-API-KEY": getBoldSignApiKey() },
    });
    if (!res.ok) throw new Error(`Auth check failed: ${res.status} ${await res.text()}`);
  },
});

Deno.test({
  name: "[gated] send -> getEmbeddedSignLink -> properties end-to-end",
  ignore: !isEnabled(),
  fn: async () => {
    const pdfBase64 = buildTestPdfBase64();
    const sendRes = await fetch(`${getBoldSignApiBase()}/v1/document/send`, {
      method: "POST",
      headers: { "X-API-KEY": getBoldSignApiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "OtterQuote/BoldSign Integration Test (D-274 / #631) — NOT A REAL CONTRACT",
        files: [`data:application/pdf;base64,${pdfBase64}`],
        signers: [
          {
            name: "Dustin Stohler (D-274 test)",
            emailAddress: TEST_RECIPIENT,
            signerOrder: 1,
            signerType: "Signer",
          },
        ],
        enableSigningOrder: true,
        enableEmbeddedSigning: true,
        useTextTags: true,
      }),
    });
    if (!sendRes.ok) throw new Error(`send failed: ${sendRes.status} ${await sendRes.text()}`);
    const { documentId } = await sendRes.json();
    if (!documentId) throw new Error("send succeeded but returned no documentId");
    console.log(`[boldsign-integration] documentId=${documentId} — check the BoldSign dashboard directly if the next steps 403`);

    const linkRes = await fetch(
      `${getBoldSignApiBase()}/v1/document/getEmbeddedSignLink?` +
        new URLSearchParams({ DocumentId: documentId, SignerEmail: TEST_RECIPIENT, RedirectUrl: "https://otterquote.com/" }),
      { headers: { "X-API-KEY": getBoldSignApiKey() } },
    );
    if (!linkRes.ok) {
      throw new Error(
        `getEmbeddedSignLink failed for documentId=${documentId}: ${linkRes.status} ${await linkRes.text()} — ` +
          `see this file's header comment for the known 403 finding before assuming a code bug.`,
      );
    }
    const { signLink } = await linkRes.json();
    if (!signLink) throw new Error("getEmbeddedSignLink succeeded but returned no signLink");

    const propsRes = await fetch(`${getBoldSignApiBase()}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`, {
      headers: { "X-API-KEY": getBoldSignApiKey() },
    });
    if (!propsRes.ok) throw new Error(`properties failed for documentId=${documentId}: ${propsRes.status} ${await propsRes.text()}`);
    const props = await propsRes.json();
    if (!Array.isArray(props.signerDetails)) {
      throw new Error(`properties response missing signerDetails[] — shape assumption in ack-verify.ts is wrong. Raw: ${JSON.stringify(props)}`);
    }

    // Cleanup — best-effort, matches docusign-artifacts.ts's void-after-capture pattern.
    await fetch(`${getBoldSignApiBase()}/v1/document/revoke?documentId=${encodeURIComponent(documentId)}`, {
      method: "POST",
      headers: { "X-API-KEY": getBoldSignApiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "D-274 integration test cleanup" }),
    }).catch(() => {});
  },
});

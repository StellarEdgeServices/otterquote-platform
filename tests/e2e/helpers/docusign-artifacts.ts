/**
 * DocuSign E2E Artifact Capture
 *
 * Downloads envelope PDFs from DocuSign immediately after creation and
 * persists them to Supabase Storage bucket 'e2e-artifacts' for CTO/GC review.
 * The PDF is captured pre-signing (showing exactly what DocuSign rendered),
 * then the envelope is voided.
 *
 * GATED: Only runs when DOCUSIGN_E2E_ENABLED=true in .env.test.
 *
 * ── Envelope quota protocol ───────────────────────────────────────────────
 * Each run burns one production DocuSign envelope (40/month limit, $75/month
 * plan). Ram (AI co-founder) decides when artifact capture is warranted and
 * gets Dustin's explicit approval before setting DOCUSIGN_E2E_ENABLED=true.
 * This flag must never be enabled in CI — manual/intentional runs only.
 *
 * ── Node.js vs Deno crypto note ──────────────────────────────────────────
 * Node.js crypto.createSign('RSA-SHA256') accepts PKCS#1 keys ('BEGIN RSA
 * PRIVATE KEY') natively. No PKCS#8 wrapping is needed here — that gotcha
 * only applies to the Deno Edge Function (crypto.subtle.importKey).
 */

import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { createAdminClient } from './auth.js';

// ── Guard ─────────────────────────────────────────────────────────────────────

export function isDocuSignE2EEnabled(): boolean {
  return process.env.DOCUSIGN_E2E_ENABLED === 'true';
}

// ── Config ────────────────────────────────────────────────────────────────────

interface DocuSignConfig {
  baseUri: string;
  integrationKey: string;
  userId: string;
  accountId: string;
  rsaPrivateKey: string;
}

function getDocuSignConfig(): DocuSignConfig {
  const baseUri = process.env.DOCUSIGN_BASE_URI;
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId = process.env.DOCUSIGN_USER_ID;
  const accountId = process.env.DOCUSIGN_API_ACCOUNT_ID;

  // RSA key: prefer file reference over inline env var (avoids newline escaping)
  const rsaKeyFile = process.env.DOCUSIGN_RSA_KEY_FILE;
  const rsaPrivateKey = rsaKeyFile
    ? readFileSync(rsaKeyFile, 'utf-8')
    : (process.env.DOCUSIGN_RSA_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

  if (!baseUri || !integrationKey || !userId || !accountId || !rsaPrivateKey) {
    throw new Error(
      'DOCUSIGN_E2E_ENABLED=true requires these vars in .env.test:\n' +
        '  DOCUSIGN_BASE_URI, DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID,\n' +
        '  DOCUSIGN_API_ACCOUNT_ID, and either DOCUSIGN_RSA_KEY_FILE or\n' +
        '  DOCUSIGN_RSA_PRIVATE_KEY (with \\n escaping).\n' +
        'See tests/e2e/README.md → E2E Artifacts for setup instructions.'
    );
  }

  return { baseUri, integrationKey, userId, accountId, rsaPrivateKey };
}

// ── DocuSign JWT Grant ────────────────────────────────────────────────────────

async function getDocuSignToken(cfg: DocuSignConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const hostname = new URL(cfg.baseUri).hostname;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: cfg.integrationKey,
      sub: cfg.userId,
      aud: hostname,
      iat: now,
      exp: now + 3600,
      scope: 'signature impersonation',
    })
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;

  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(cfg.rsaPrivateKey, 'base64url');

  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch(`${cfg.baseUri}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DocuSign token request failed ${resp.status}: ${body}`);
  }

  return ((await resp.json()) as { access_token: string }).access_token;
}

// ── DocuSign API ──────────────────────────────────────────────────────────────

async function downloadEnvelopePdf(
  cfg: DocuSignConfig,
  envelopeId: string,
  accessToken: string
): Promise<Buffer> {
  const url =
    `${cfg.baseUri}/restapi/v2.1/accounts/${cfg.accountId}` +
    `/envelopes/${envelopeId}/documents/combined`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DocuSign PDF download failed ${resp.status}: ${body}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

async function voidEnvelope(
  cfg: DocuSignConfig,
  envelopeId: string,
  accessToken: string
): Promise<void> {
  const url =
    `${cfg.baseUri}/restapi/v2.1/accounts/${cfg.accountId}/envelopes/${envelopeId}`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'voided',
      voidedReason: 'E2E artifact capture — automated void after PDF download',
    }),
  });

  if (!resp.ok) {
    // Non-fatal: PDF is already saved. Log a warning and continue.
    const body = await resp.text();
    console.warn(`  ⚠️  Envelope void returned ${resp.status}: ${body}`);
  }
}

// ── Supabase Storage ──────────────────────────────────────────────────────────

async function uploadArtifact(
  phase: '1' | '2',
  runId: string,
  envelopeId: string,
  pdfBuffer: Buffer
): Promise<string> {
  const supabase = createAdminClient();
  const storagePath = `phase-${phase}/${runId}/${envelopeId}.pdf`;

  const { error } = await supabase.storage
    .from('e2e-artifacts')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  return storagePath;
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface ArtifactManifestEntry {
  envelopeId: string;
  storagePath: string;
  capturedAt: string;
  status: 'captured' | 'voided' | 'error';
  error?: string;
}

async function writeManifest(
  phase: '1' | '2',
  runId: string,
  artifacts: ArtifactManifestEntry[]
): Promise<void> {
  const supabase = createAdminClient();
  const manifest = {
    phase,
    runId,
    generatedAt: new Date().toISOString(),
    artifacts,
  };

  const manifestPath = `phase-${phase}/${runId}/manifest.json`;
  const { error } = await supabase.storage
    .from('e2e-artifacts')
    .upload(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)), {
      contentType: 'application/json',
      upsert: true,
    });

  if (error) {
    console.warn(`  ⚠️  Manifest write failed: ${error.message}`);
  } else {
    console.log(`  📋 Manifest: e2e-artifacts/${manifestPath}`);
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function captureEnvelopeArtifact(
  cfg: DocuSignConfig,
  phase: '1' | '2',
  runId: string,
  envelopeId: string
): Promise<ArtifactManifestEntry> {
  const capturedAt = new Date().toISOString();

  try {
    console.log(`  📄 Capturing envelope ${envelopeId}...`);
    const accessToken = await getDocuSignToken(cfg);
    const pdfBuffer = await downloadEnvelopePdf(cfg, envelopeId, accessToken);
    const storagePath = await uploadArtifact(phase, runId, envelopeId, pdfBuffer);

    console.log(
      `  ✅ PDF saved: e2e-artifacts/${storagePath} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`
    );

    await voidEnvelope(cfg, envelopeId, accessToken);
    console.log(`  🗑️  Envelope ${envelopeId} voided`);

    return { envelopeId, storagePath, capturedAt, status: 'voided' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Artifact capture failed for ${envelopeId}: ${message}`);
    return { envelopeId, storagePath: '', capturedAt, status: 'error', error: message };
  }
}

/**
 * Runs the full artifact capture flow for a test phase.
 * Called from afterAll hooks in spec files.
 *
 * - If DOCUSIGN_E2E_ENABLED is not 'true': no-op (logs a skip message).
 * - If no envelope IDs: writes an empty manifest (documents that DocuSign
 *   was not triggered in this run — expected until B8/B9 are wired in).
 * - If envelope IDs present: downloads PDFs, uploads to storage, voids envelopes,
 *   writes manifest.
 *
 * Never throws — any error is caught and recorded in the manifest.
 *
 * @param phase       '1' = contractor journey (Flow A), '2' = homeowner journey (Flow B)
 * @param runId       Unique run identifier from .test-state.json
 * @param envelopeIds DocuSign envelope IDs found on the test claim
 */
export async function runArtifactCapture(
  phase: '1' | '2',
  runId: string,
  envelopeIds: string[]
): Promise<void> {
  if (!isDocuSignE2EEnabled()) {
    console.log(
      `\n[e2e-artifacts] Phase ${phase}: DOCUSIGN_E2E_ENABLED not set — skipping artifact capture.`
    );
    return;
  }

  if (envelopeIds.length === 0) {
    console.log(
      `\n[e2e-artifacts] Phase ${phase}: no envelope found on test claim — writing empty manifest.`
    );
    try {
      const cfg = getDocuSignConfig();
      void cfg; // validate config is present even for empty manifests
      await writeManifest(phase, runId, []);
    } catch (err: unknown) {
      console.warn(
        `[e2e-artifacts] Manifest write skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  let cfg: DocuSignConfig;
  try {
    cfg = getDocuSignConfig();
  } catch (err: unknown) {
    console.error(
      `[e2e-artifacts] Config error — artifact capture aborted:\n` +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }

  console.log(
    `\n[e2e-artifacts] Phase ${phase} artifact capture — ${envelopeIds.length} envelope(s)`
  );

  const entries: ArtifactManifestEntry[] = [];
  for (const envelopeId of envelopeIds) {
    entries.push(await captureEnvelopeArtifact(cfg, phase, runId, envelopeId));
  }

  await writeManifest(phase, runId, entries);
  console.log(`[e2e-artifacts] Phase ${phase} capture complete.\n`);
}

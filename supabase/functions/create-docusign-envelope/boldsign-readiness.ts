// gh-1842: tell "still building" apart from "will never build".
//
// BACKGROUND, and why the old single-message helper was wrong.
//
// `POST /v1/document/send` returns 201 + a documentId as soon as BoldSign
// accepts the request; Text Tag discovery/validation then runs ASYNCHRONOUSLY.
// Reads on that id return 403 until it finishes (gh-1244 proved this live: the
// identical documentId, key and endpoint 403'd 2.5 s after send and returned a
// signing URL 4 minutes later). So a 403 must not be treated as a permission
// error, and the old `waitForBoldSignDocumentReady()` was right to poll.
//
// What it could not do is distinguish that case from PERMANENT failure. When
// background validation fails -- a malformed PDF is the known cause -- the
// document 403s forever. The old helper burned its full 15 s ceiling and then
// threw a message asserting "This is a wait timeout, not a permission or scope
// problem", which is the WRONG diagnosis for that case and is the sentence the
// next engineer reads at 2 a.m.
//
// THE DISCRIMINATOR, measured on the live production key on 2026-09-08 and
// recorded on #1842: a document that never finished creation is absent from
// `GET /v1/document/list` in EVERY status, including Draft, while all 6
// documents that DID finish creation return 200 from /v1/document/properties
// and appear in the list. The asymmetry is per-document, not per-key -- which
// is exactly why "the key lost read permission" is the wrong story and why an
// absence probe is a sound signal rather than a guess.
//
// So: poll properties as before, and once the document has been 403ing for
// longer than a slow-but-normal creation plausibly takes, ask the list
// endpoint whether BoldSign knows about it at all. Absent everywhere =>
// permanent. Present => keep waiting and, if the ceiling is reached, say
// plainly that the document IS listed and creation is still in progress.
//
// ⛔ Deliberately NOT done here: replying to BoldSign, or trying to revoke the
// stranded document. #1754's closure rules that out with reasons, and the one
// stranded document (09400a4b-6682-4ee5-b3bb-c73dfc854ad3) is unrevocable
// through the API anyway -- POST /v1/document/revoke returns 403 for it.

// gh-2105 (PR #2240 REVIEW FAIL, F3): the clearing writes in
// clearStrandedEnvelopePointer() below must DETECT a zero-row match, not
// annotate it away -- checkRowsWritten() is the same shared guard
// docusign-webhook/index.ts and mark-payout-paid/index.ts already use for
// this pattern.
import { checkRowsWritten } from "../_shared/zero-row-update-guard.ts";

export const BOLDSIGN_PERMANENT_MARKER = "BOLDSIGN_PERMANENT_CREATION_FAILURE";

/** Thrown when BoldSign accepted the send but background creation will never finish. */
export class BoldSignPermanentCreationFailure extends Error {
  readonly permanent = true;
  readonly documentId: string;
  constructor(documentId: string, detail: string) {
    super(
      `${BOLDSIGN_PERMANENT_MARKER}: BoldSign document ${documentId} was accepted by ` +
      `/v1/document/send but its background creation FAILED PERMANENTLY -- it 403s on ` +
      `properties and does not appear in /v1/document/list under any status, so it will ` +
      `never become readable, cannot be signed, and cannot be revoked through the API. ` +
      `This is NOT a wait timeout and NOT a permission or scope problem: other documents ` +
      `on the same key read 200 in the same session. The usual cause is a malformed PDF ` +
      `that fails Text Tag validation. ${detail}`
    );
    this.name = "BoldSignPermanentCreationFailure";
    this.documentId = documentId;
  }
}

/** Thrown when the document is still building when the ceiling is reached. */
export class BoldSignReadinessTimeout extends Error {
  readonly permanent = false;
  readonly documentId: string;
  constructor(documentId: string, ceilingMs: number, detail: string) {
    super(
      `BoldSign document ${documentId} did not finish background creation within ` +
      `${ceilingMs}ms. The document IS present in /v1/document/list, so creation is still ` +
      `in progress rather than failed -- retrying the same documentId is correct and it ` +
      `must NOT be re-minted. ${detail}`
    );
    this.name = "BoldSignReadinessTimeout";
    this.documentId = documentId;
  }
}

/**
 * True only for a proven-permanent creation failure. The caller uses this to
 * decide whether to UN-RECORD the envelope id it has already written.
 *
 * It is deliberately narrow: a timeout, a network blip or any other error
 * returns false, because clearing the pointer on an ambiguous failure would
 * re-mint a second paid document over a first one that was merely slow --
 * which is the failure gh-1400's write-first ordering exists to prevent.
 */
export function isPermanentCreationFailure(err: unknown): boolean {
  if (err instanceof BoldSignPermanentCreationFailure) return true;
  return err instanceof Error && typeof err.message === "string" &&
    err.message.includes(BOLDSIGN_PERMANENT_MARKER);
}

export interface StrandedEnvelopeClearTarget {
  claim_id: string;
  quote_id?: string | null;
  contractor_id?: string | null;
  envelopeId: string;
}

/**
 * Un-record a stranded envelope pointer on a PROVEN-permanent BoldSign
 * creation failure. Shared by every call site that can discover such a
 * failure -- the mint path (a fresh /v1/document/send) AND the resume path
 * (requestBody.resolved_envelope_id, where the failure is discovered on
 * READ rather than at mint time, so it can surface on any later retry, not
 * only the attempt that minted it) -- so a corpse found on either path is
 * cleared identically: same fields, same guard.
 *
 * The caller decides IF this runs (via isPermanentCreationFailure(err)) --
 * this function does not re-check that. It always clears when called, which
 * is why the gate at the call site must stay narrow: a timeout or network
 * error must never reach here, or it would re-mint a second paid document
 * over a first one that was merely slow (gh-1400's failure, inverted).
 *
 * REVIEW FAIL (PR #2240, F1): on the resume path the pointer was NOT written
 * by this request -- findExistingEnvelopeId() may have found it via the
 * (claim_id, contractor_id) fallback rather than the caller's own quote_id.
 * Guarding the quotes clear on `.eq("id", quote_id)` alone (no envelope
 * check) could therefore hit the WRONG quote (a zero-effect null on an
 * already-null pointer while the real corpse row keeps its dead id) or, in a
 * race with a concurrent mint, wipe a brand-new pointer a third request just
 * wrote (gh-1400 inverted). So BOTH quotes branches are now additionally
 * guarded on `.eq("docusign_envelope_id", envelopeId)`, exactly like the
 * claims clear already was -- a zero-row match on any of the three writes
 * below now can ONLY mean something else already cleared or replaced this
 * exact pointer, never "matched a different row that happens to share an id
 * or claim/contractor pair."
 *
 * Each write chains `.select("id")` and reports whether it matched a row via
 * `checkRowsWritten()` (gh-2105's shared zero-row guard) instead of an
 * `update-no-select-ok` comment -- a zero-row match on a money path is
 * detected and logged, not merely asserted harmless.
 */
export async function clearStrandedEnvelopePointer(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  { claim_id, quote_id, contractor_id, envelopeId }: StrandedEnvelopeClearTarget,
): Promise<
  { quoteClearError: unknown; claimClearError: unknown; quoteRows: number; claimRows: number }
> {
  let quoteClearError: unknown;
  let quoteData: unknown;
  if (quote_id) {
    // Guarded on the envelope id (not just the caller-supplied quote_id) --
    // see the REVIEW FAIL note above this function. A zero-row match here is
    // detected via checkRowsWritten() below, not annotated away.
    const { data, error } = await supabase.from("quotes").update({ docusign_envelope_id: null })
      .eq("id", quote_id).eq("docusign_envelope_id", envelopeId).select("id");
    quoteData = data;
    quoteClearError = error;
  } else {
    // Same guard, for the claim_id+contractor_id fallback this function's
    // caller uses when it has no quote_id of its own (e.g. the resume path,
    // which does not trust findExistingEnvelopeId()'s resolved quote_id).
    const { data, error } = await supabase.from("quotes").update({ docusign_envelope_id: null })
      .eq("claim_id", claim_id).eq("contractor_id", contractor_id).eq("docusign_envelope_id", envelopeId)
      .select("id");
    quoteData = data;
    quoteClearError = error;
  }
  // Already guarded on .eq("docusign_envelope_id", envelopeId) since #1868 --
  // unchanged here except for the added .select("id").
  const { data: claimData, error: claimClearError } = await supabase.from("claims").update({
    docusign_envelope_id: null,
    contract_sent_at: null,
  }).eq("id", claim_id).eq("docusign_envelope_id", envelopeId).select("id");
  return {
    quoteClearError,
    claimClearError,
    quoteRows: checkRowsWritten(quoteData).rowCount,
    claimRows: checkRowsWritten(claimData).rowCount,
  };
}

// gh-1842 (comment 5869362477/5869347983): "InProgress" is NOT a valid value
// for this endpoint's Status filter -- BoldSign's List Documents API rejects
// it with 400 "The value 'InProgress' is not valid.", confirmed live via 3
// direct read-only calls, 2026-09-28. Because documentIsListed() below aborts
// its ENTIRE absence probe (all statuses) on the first non-OK page, that one
// invalid value made isPermanentCreationFailure unreachable in production on
// both the mint and resume paths -- every probe died at this entry before
// ever reaching Completed/Declined/Revoked/Expired.
//
// This is the full documented Status enum for the List Documents endpoint
// (https://developers.boldsign.com/documents/list-documents/, "Query
// parameters" -> Status, fetched 2026-09-28): "You can set None if you don't
// want to filter based on the document status. Other values are
// WaitingForMe, WaitingForOthers, NeedAttention, Completed, Declined,
// Revoked, Expired, Scheduled, and Draft." `None` is excluded here -- it
// means "don't filter," not a document state, so looping over it would just
// re-fetch the unfiltered list N times. `WaitingForOthers` is the in-flight
// value this probe actually needs (BoldSign's replacement for the invalid
// "InProgress" this array used to carry). LIST_STATUSES is pinned against
// this exact enum by a contract test in boldsign-readiness.test.ts -- a
// status string outside it fails that test.
export const LIST_STATUSES = [
  "Draft",
  "WaitingForMe",
  "WaitingForOthers",
  "NeedAttention",
  "Completed",
  "Declined",
  "Revoked",
  "Expired",
  "Scheduled",
];

async function documentIsListed(
  documentId: string,
  { apiBase, headers, fetchImpl, pageSize = 100, maxPages = 5 }: {
    apiBase: string; headers: Record<string, string>;
    fetchImpl: typeof fetch; pageSize?: number; maxPages?: number;
  },
): Promise<{ listed: boolean; probed: boolean; note: string }> {
  let anyPageRead = false;
  for (const status of LIST_STATUSES) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${apiBase}/v1/document/list?PageSize=${pageSize}&Page=${page}&Status=${status}`;
      let res: Response;
      try {
        res = await fetchImpl(url, { headers });
      } catch (e) {
        // A network failure on the probe is NOT evidence of absence.
        return { listed: false, probed: false, note: `list probe failed: ${String(e)}` };
      }
      if (!res.ok) return { listed: false, probed: false, note: `list probe HTTP ${res.status}` };
      anyPageRead = true;
      let body: { result?: Array<{ documentId?: string }> };
      try {
        body = await res.json();
      } catch (e) {
        return { listed: false, probed: false, note: `list probe unparseable: ${String(e)}` };
      }
      const rows = Array.isArray(body?.result) ? body.result : [];
      if (rows.some((r) => r?.documentId === documentId)) {
        return { listed: true, probed: true, note: `found under status=${status} page=${page}` };
      }
      if (rows.length < pageSize) break; // last page for this status
    }
  }
  // Absence only counts if we actually managed to read the list.
  return anyPageRead
    ? { listed: false, probed: true, note: "absent from every status page read" }
    : { listed: false, probed: false, note: "list endpoint returned no readable page" };
}

/**
 * Poll /v1/document/properties until the document is readable.
 *
 * Resolves on the first 200. Throws BoldSignPermanentCreationFailure once the
 * document has 403'd past `absenceProbeAfterMs` AND a successful list probe
 * shows BoldSign does not know about it. Throws BoldSignReadinessTimeout if the
 * ceiling is reached while the document is (or may be) still building.
 */
export async function waitForBoldSignDocumentReady(
  documentId: string,
  {
    apiBase,
    headers,
    fetchImpl = fetch,
    intervalMs = 200,
    ceilingMs = 15000,
    absenceProbeAfterMs = 5000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    apiBase: string; headers: Record<string, string>; fetchImpl?: typeof fetch;
    intervalMs?: number; ceilingMs?: number; absenceProbeAfterMs?: number;
    now?: () => number; sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const started = now();
  const deadline = started + ceilingMs;
  let lastStatus: number | null = null;
  let lastBody = "";
  let probeNote = "list probe not reached";
  let probed = false;

  while (now() < deadline) {
    const res = await fetchImpl(
      `${apiBase}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`,
      { headers },
    );
    if (res.ok) return;
    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");

    if (!probed && now() - started >= absenceProbeAfterMs) {
      const probe = await documentIsListed(documentId, { apiBase, headers, fetchImpl });
      probeNote = probe.note;
      if (probe.probed) {
        probed = true;
        if (!probe.listed) {
          throw new BoldSignPermanentCreationFailure(
            documentId,
            `Last properties response: ${lastStatus} ${lastBody}. List probe: ${probe.note}.`,
          );
        }
      }
    }
    await sleep(intervalMs);
  }
  throw new BoldSignReadinessTimeout(
    documentId,
    ceilingMs,
    `Last properties response: ${lastStatus} ${lastBody}. List probe: ${probeNote}.`,
  );
}

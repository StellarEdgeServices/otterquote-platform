/**
 * record-lead-loss-sheet-upload -- request handling for HO-3's no-account
 * insurance loss-sheet upload.
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from loss-sheet-lead.html. Stores the
 * uploaded file under Storage bucket lead-loss-sheets/<lead_id>/... and a
 * `lead_loss_sheet_uploads` row (status='received') for an admin to review by
 * hand.
 *
 * NOT built in this PR: automatic parsing via parse-loss-sheet. That function
 * is bound to a `claims` row (ownership check against claims.user_id, and it
 * writes to claims.parsed_line_items / claims.contractor_scope_summary /
 * etc.) -- a lead with no account has neither. Confirmed by reading
 * parse-loss-sheet/index.ts this build (not assumed): see the PR body for the
 * follow-up this leaves open.
 *
 * The file arrives as base64 in the JSON body (mirrors this repo's existing
 * pattern for a small-ish binary payload through an Edge Function -- see
 * parse-loss-sheet's own PDF-to-base64 handling, in reverse). Capped well
 * under Supabase's request-body limit; a larger file is refused with a clear
 * error rather than silently truncated.
 *
 * No imports here (unit-tested with a fake storage/DB) -- index.ts wires the
 * real Supabase client and Deno's server.
 */

export const FUNCTION_NAME = "record-lead-loss-sheet-upload";
export const MAX_BASE64_LENGTH = 8_000_000; // ~6MB decoded -- generous for a PDF/photo of a loss sheet, well under the 8MB request-body concern the Arm F header raises for a different endpoint.
export const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function getClientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return null;
}

/** A safe, extension-preserving basename -- never the caller's raw filename verbatim in a storage path. */
export function safeFileName(name: unknown): string {
  const raw = typeof name === "string" ? name : "upload";
  const extMatch = raw.match(/\.[A-Za-z0-9]{1,8}$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  return `upload${ext}`;
}

export interface ValidBody {
  leadToken: string;
  contentType: string;
  base64Data: string;
  originalFilename: string | null;
}

export type Validation = { ok: true; value: ValidBody } | { ok: false; error: string };

export function validateBody(raw: unknown): Validation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;

  const leadToken = typeof b.lead_token === "string" ? b.lead_token.trim() : "";
  if (!leadToken || leadToken.length < 16 || leadToken.length > 512) {
    return { ok: false, error: "lead_token is required" };
  }

  const contentType = typeof b.content_type === "string" ? b.content_type.toLowerCase().trim() : "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { ok: false, error: "Unsupported file type. Please upload a PDF, JPEG, PNG, or HEIC." };
  }

  const base64Data = typeof b.file_base64 === "string" ? b.file_base64 : "";
  if (!base64Data) return { ok: false, error: "file_base64 is required" };
  if (base64Data.length > MAX_BASE64_LENGTH) {
    return { ok: false, error: "File is too large. Please upload a file under 6MB." };
  }

  const originalFilename = typeof b.filename === "string" ? b.filename.slice(0, 200) : null;

  return { ok: true, value: { leadToken, contentType, base64Data, originalFilename } };
}

export interface ResolvedLead {
  leadId: string;
}

export interface Deps {
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  checkRateLimit: (bucketIp: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** Uploads the decoded bytes to Storage and returns the stored path. */
  uploadToStorage: (args: { leadId: string; fileName: string; contentType: string; base64Data: string }) => Promise<{ storagePath: string } | { error: string }>;
  insertUploadRow: (row: {
    leadId: string;
    storagePath: string;
    originalFilename: string | null;
    contentType: string;
    byteSize: number;
  }) => Promise<{ id: string } | { error: string }>;
  notifyUploadReceived: (args: { id: string; leadId: string }) => Promise<void>;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, corsHeaders);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400, corsHeaders);

  const rl = await deps.checkRateLimit(getClientIp(req) ?? "unknown");
  if (!rl.allowed) return json({ error: "Rate limit exceeded", reason: rl.reason }, 429, corsHeaders);

  // Ruling 3 / negative control: resolved server-side from the token. An
  // invalid/expired token means no lead, and nothing is ever written to
  // Storage or the database for it.
  const lead = await deps.resolveLead(parsed.value.leadToken);
  if (!lead) return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);

  const fileName = safeFileName(parsed.value.originalFilename);
  const uploaded = await deps.uploadToStorage({
    leadId: lead.leadId,
    fileName,
    contentType: parsed.value.contentType,
    base64Data: parsed.value.base64Data,
  });
  if ("error" in uploaded) {
    console.error(`[${FUNCTION_NAME}] storage upload failed:`, uploaded.error);
    return json({ error: "Could not upload your file. Please try again." }, 500, corsHeaders);
  }

  // Decoded byte size is what gets stored, not the (larger) base64 length.
  const byteSize = Math.floor((parsed.value.base64Data.length * 3) / 4);

  const inserted = await deps.insertUploadRow({
    leadId: lead.leadId,
    storagePath: uploaded.storagePath,
    originalFilename: parsed.value.originalFilename,
    contentType: parsed.value.contentType,
    byteSize,
  });
  if ("error" in inserted) {
    // The file is already in Storage even though the row failed -- log
    // loudly so an admin can reconcile it, but don't ask the visitor to
    // re-upload (their loss sheet already landed).
    console.error(`[${FUNCTION_NAME}] upload row insert failed AFTER a successful storage write (${uploaded.storagePath}):`, inserted.error);
    return json({ error: "Your file uploaded, but we could not finish recording it. We will follow up if we need anything else." }, 200, corsHeaders);
  }

  await deps.notifyUploadReceived({ id: inserted.id, leadId: lead.leadId }).catch((e) => {
    console.error(`[${FUNCTION_NAME}] notifyUploadReceived failed (upload already recorded):`, e instanceof Error ? e.message : e);
  });

  return json({ ok: true, upload_id: inserted.id }, 200, corsHeaders);
}

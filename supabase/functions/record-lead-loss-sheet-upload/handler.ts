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
/** 6 MiB decoded -- the same number the page, this handler, the table CHECK and the Storage bucket all enforce (PR #2226 REVIEW D13). */
export const MAX_FILE_BYTES = 6 * 1024 * 1024;
/** The exact base64 length of a MAX_FILE_BYTES file: Math.ceil(6 MiB / 3) * 4 = 8,388,608 chars. */
export const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;

export type SniffedType = { contentType: "application/pdf" | "image/jpeg" | "image/png" | "image/heic"; ext: "pdf" | "jpg" | "png" | "heic" };

const HEIC_BRANDS = new Set(["heic", "heix", "mif1", "msf1"]);

/**
 * D13: the file type is decided by its leading bytes, never by the client's
 * content_type or filename. Returns null for anything that is not a PDF,
 * JPEG, PNG or HEIC -- including HTML/SVG renamed to .pdf.
 */
export function sniffFileType(head: Uint8Array): SniffedType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head.length >= 5 && ascii(0, 5) === "%PDF-") return { contentType: "application/pdf", ext: "pdf" };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { contentType: "image/jpeg", ext: "jpg" };
  if (
    head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return { contentType: "image/png", ext: "png" };
  if (head.length >= 12 && ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12))) return { contentType: "image/heic", ext: "heic" };
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Exact decoded byte length of a (validated) base64 string. */
export function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Decodes only the first 18 bytes (24 base64 chars) -- enough for every signature above. */
export function decodeHead(base64: string): Uint8Array {
  const bin = atob(base64.slice(0, 24));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

export interface ValidBody {
  leadToken: string;
  sniffed: SniffedType;
  base64Data: string;
  byteSize: number;
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

  const base64Data = typeof b.file_base64 === "string" ? b.file_base64 : "";
  if (!base64Data) return { ok: false, error: "file_base64 is required" };
  if (base64Data.length > MAX_BASE64_LENGTH) {
    return { ok: false, error: "File is too large. Please upload a file under 6MB." };
  }
  if (base64Data.length % 4 !== 0 || !BASE64_RE.test(base64Data)) {
    return { ok: false, error: "The file could not be read. Please choose it again." };
  }
  const byteSize = decodedByteLength(base64Data);
  if (byteSize <= 0 || byteSize > MAX_FILE_BYTES) {
    return { ok: false, error: "File is too large. Please upload a file under 6MB." };
  }

  const sniffed = sniffFileType(decodeHead(base64Data));
  if (!sniffed) {
    return { ok: false, error: "Unsupported file type. Please upload a PDF, JPEG, PNG, or HEIC." };
  }

  const originalFilename = typeof b.filename === "string" ? b.filename.slice(0, 200) : null;
  return { ok: true, value: { leadToken, sniffed, base64Data, byteSize, originalFilename } };
}

export interface ResolvedLead {
  leadId: string;
  isSynthetic: boolean;
}

export interface Deps {
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  checkRateLimit: (bucketIp: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** Uploads the decoded bytes to Storage under a server-built path and returns it. */
  uploadToStorage: (args: { leadId: string; fileName: string; contentType: string; base64Data: string }) => Promise<{ storagePath: string } | { error: string }>;
  insertUploadRow: (row: {
    leadId: string;
    storagePath: string;
    originalFilename: string | null;
    contentType: string;
    byteSize: number;
    isTest: boolean;
  }) => Promise<{ id: string } | { error: string }>;
  /** platform_alerts_log row; must never throw. */
  alert: (alertType: string, message: string) => Promise<void>;
  /** Admin email via notify-measurement-order (lead_upload branch). */
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
  if (!rl.allowed) return json({ error: "Too many requests. Please try again later.", reason: rl.reason }, 429, corsHeaders);

  // Ruling 3 / negative control: resolved server-side from the token. An
  // invalid/expired token means no lead, and nothing is ever written.
  const lead = await deps.resolveLead(parsed.value.leadToken);
  if (!lead) return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);

  // D13: the stored name and type come from the sniffed bytes, never the client.
  const fileName = `upload.${parsed.value.sniffed.ext}`;
  const contentType = parsed.value.sniffed.contentType;
  const uploaded = await deps.uploadToStorage({
    leadId: lead.leadId,
    fileName,
    contentType,
    base64Data: parsed.value.base64Data,
  });
  if ("error" in uploaded) {
    console.error(`[${FUNCTION_NAME}] storage upload failed`);
    return json({ error: "Could not upload your file. Please try again." }, 500, corsHeaders);
  }

  const inserted = await deps.insertUploadRow({
    leadId: lead.leadId,
    storagePath: uploaded.storagePath,
    originalFilename: parsed.value.originalFilename,
    contentType,
    byteSize: parsed.value.byteSize,
    isTest: lead.isSynthetic,
  });
  if ("error" in inserted) {
    // The file is in Storage but has no row: alert an operator (never silent),
    // and do not ask the visitor to upload again.
    await deps.alert(
      "lead_loss_sheet_unrecorded",
      `HO-3 loss-sheet file stored but its row failed to insert; storage path ${uploaded.storagePath}. Reconcile by hand.`,
    );
    return json({ ok: true, recorded: false }, 200, corsHeaders);
  }

  await deps.notifyUploadReceived({ id: inserted.id, leadId: lead.leadId }).catch(() => {
    console.error(`[${FUNCTION_NAME}] notifyUploadReceived failed (upload already recorded)`);
  });

  return json({ ok: true, upload_id: inserted.id }, 200, corsHeaders);
}

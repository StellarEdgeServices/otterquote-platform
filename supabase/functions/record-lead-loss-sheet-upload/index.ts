/**
 * OtterQuote Edge Function: record-lead-loss-sheet-upload
 *
 * gh-2121 (HO-3, #2121 row 3.2). Stores a loss-sheet file for a lead with no
 * account -- see ./handler.ts for the full contract, including why this PR
 * does not call parse-loss-sheet (that function is claims-bound), and
 * ./handler.test.ts for the unit tests.
 *
 * verify_jwt is pinned to false in supabase/config.toml: authorization is the
 * lead_token (resolved server-side, Ruling 3) plus the per-IP rate limit.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { handleRequest } from "./handler.ts";

const FUNCTION_NAME = "record-lead-loss-sheet-upload";
const BUCKET = "lead-loss-sheets";

const sb = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
);

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

serve((req: Request) =>
  handleRequest(req, {
    resolveLead: async (leadToken) => {
      const { data, error } = await sb.rpc("resolve_lead_by_token", { p_token: leadToken });
      if (error) {
        console.error(`[${FUNCTION_NAME}] resolve_lead_by_token rpc failed`);
        return null;
      }
      const rows = Array.isArray(data) ? data : [];
      const row = rows[0] as { lead_id?: string } | undefined;
      return row?.lead_id ? { leadId: row.lead_id } : null;
    },
    checkRateLimit: async (bucketIp) => {
      const bucketUuid = await ipToUuid(bucketIp);
      const { data, error } = await sb.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: bucketUuid,
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] rate limit check failed:`, error);
        return { allowed: false, reason: "rate_limit_check_failed" };
      }
      const parsed = data as { allowed?: boolean; reason?: string } | null;
      return { allowed: parsed?.allowed === true, reason: parsed?.reason };
    },
    uploadToStorage: async ({ leadId, fileName, contentType, base64Data }) => {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(base64Data);
      } catch {
        return { error: "invalid base64" };
      }
      const storagePath = `${leadId}/${Date.now()}-${fileName}`;
      const { error } = await sb.storage.from(BUCKET).upload(storagePath, bytes, {
        contentType,
        upsert: false,
      });
      if (error) return { error: error.message };
      return { storagePath };
    },
    insertUploadRow: async ({ leadId, storagePath, originalFilename, contentType, byteSize }) => {
      const { data, error } = await sb
        .from("lead_loss_sheet_uploads")
        .insert({
          lead_id: leadId,
          storage_path: storagePath,
          original_filename: originalFilename,
          content_type: contentType,
          byte_size: byteSize,
          status: "received",
        })
        .select("id")
        .single();
      if (error || !data) return { error: error?.message ?? "insert failed" };
      return data;
    },
    notifyUploadReceived: async ({ id, leadId }) => {
      try {
        const { error: logErr } = await sb.from("activity_log").insert({
          event_type: "lead_loss_sheet_uploaded",
          title: "lead_loss_sheet_uploaded",
          user_id: null,
          is_test: false,
          metadata: { upload_id: id, lead_id: leadId },
        });
        if (logErr) console.error(`[${FUNCTION_NAME}] activity_log insert failed:`, logErr);
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] activity_log write threw:`, e);
      }
    },
  })
);

async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

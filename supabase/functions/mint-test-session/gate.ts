// mint-test-session/gate.ts
//
// Pure R-174 gating + response-shaping logic for mint-test-session, split
// out of index.ts (same pattern as notify-contractors/test-exclusion.ts and
// docusign-webhook/*-guard.ts) so it can be unit-tested with a fake
// DbAdapter — no live Supabase client, no network listener. index.ts wires
// a real @supabase/supabase-js service-role client into the DbAdapter shape
// below and calls resolveAndMint from inside serve().
//
// gh-1513, R-174: minting is permitted ONLY for rows whose is_test column is
// literally true, re-derived from a live query every call — never from a
// caller-supplied flag.

export interface ContractorRow {
  id: string;
  user_id: string | null;
  email: string;
  is_test: boolean;
}

export interface ClaimRow {
  id: string;
  is_test: boolean;
}

export interface AuthUserRow {
  id: string;
  email: string | null;
}

export interface GenerateLinkData {
  action_link: string;
}

export interface AdapterError {
  message: string;
}

export interface ActivityLogRow {
  user_id: string;
  event_type: string;
  title: string;
  is_test: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Everything resolveAndMint needs from the outside world, expressed as a
 * structural interface so tests can pass a plain object literal instead of
 * a real Supabase client.
 */
export interface DbAdapter {
  getContractorById(
    id: string,
  ): Promise<{ data: ContractorRow | null; error: AdapterError | null }>;
  getClaimsByUserId(
    userId: string,
  ): Promise<{ data: ClaimRow[] | null; error: AdapterError | null }>;
  getAuthUserById(
    userId: string,
  ): Promise<{ data: AuthUserRow | null; error: AdapterError | null }>;
  generateMagicLink(
    email: string,
  ): Promise<{ data: GenerateLinkData | null; error: AdapterError | null }>;
  insertActivityLog(
    row: ActivityLogRow,
  ): Promise<{ error: AdapterError | null }>;
}

export interface MintInput {
  contractor_id?: unknown;
  user_id?: unknown;
}

export interface MintResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Default magic-link OTP expiry, in seconds. The admin generateLink response
 * carries no expires_in field of its own; this mirrors the project's GoTrue
 * default (supabase/config.toml [auth] sets no otp_expiry override, so the
 * platform default of 3600s / 1hr applies).
 */
export const MAGIC_LINK_EXPIRES_IN = 3600;

function jsonError(status: number, error: string): MintResult {
  return { status, body: { error } };
}

/**
 * gh-1562 (CodeQL js/stack-trace-exposure): the single sink for every error
 * path in this function that reaches an HTTP response, whether the error
 * arrives as a thrown exception (index.ts's outer catch-all — auth client
 * construction, anything unexpected) or as a returned `{ error }` from a
 * DbAdapter call inside resolveAndMint (getContractorById, getClaimsByUserId,
 * getAuthUserById, generateMagicLink — gh-1562 fixup, PR #1563 review: these
 * four were still shipping raw adapter error text after the first pass).
 * This is a credential-minting endpoint, so error detail — a message, a
 * stack, PostgREST/driver text — can leak internal structure to whoever can
 * reach it. The function has no Sentry init, so console.error is the only
 * server-side detail sink; the response body is always the same fixed,
 * generic string — never error.message, error.stack, or String(error).
 */
export function unexpectedErrorResponse(error: unknown): MintResult {
  console.error("mint-test-session error:", error);
  return jsonError(500, "Internal server error");
}

/**
 * Core R-174 gate + mint logic.
 *
 * Input: exactly one of contractor_id | user_id (non-empty string).
 *   - contractor_id: 403 unless contractors.is_test is literally true for
 *     that row. Target is the contractor's linked auth user (user_id).
 *   - user_id: 403 unless the user owns at least one claim AND every claim
 *     they own has is_test = true. Target is that user_id directly.
 *
 * On success, mints a Supabase magic link for the target's email via
 * db.generateMagicLink, writes a non-fatal activity_log row
 * (event_type: "test_session_minted", actor = caller identity in metadata,
 * target = user_id), and returns the { ok, action_link, user_id, email,
 * is_test: true, expires_in } shape.
 */
export async function resolveAndMint(
  input: MintInput,
  db: DbAdapter,
  actorEmail: string,
): Promise<MintResult> {
  const contractorId =
    typeof input.contractor_id === "string" && input.contractor_id.length > 0
      ? input.contractor_id
      : undefined;
  const userId =
    typeof input.user_id === "string" && input.user_id.length > 0
      ? input.user_id
      : undefined;

  if ((contractorId === undefined) === (userId === undefined)) {
    return jsonError(400, "Provide exactly one of contractor_id or user_id");
  }

  let targetUserId: string;
  let targetEmail: string;
  let resolvedContractorId: string | null = null;

  if (contractorId !== undefined) {
    const { data: contractor, error } = await db.getContractorById(contractorId);
    // gh-1562 fixup: this used to be `jsonError(500, error.message)`, which
    // put the raw Supabase/PostgREST adapter error text straight into the
    // response body — the same leak class as the outer catch-all in
    // index.ts, just reached via a returned `{error}` shape instead of a
    // thrown exception. Route it through the same sink as that catch-all.
    if (error) return unexpectedErrorResponse(error);
    if (!contractor) return jsonError(404, "Contractor not found");
    if (contractor.is_test !== true) {
      return jsonError(403, "Forbidden: contractor is not marked is_test");
    }
    if (!contractor.user_id) {
      return jsonError(404, "Contractor has no linked auth user");
    }
    targetUserId = contractor.user_id;
    targetEmail = contractor.email;
    resolvedContractorId = contractor.id;
  } else {
    const { data: claims, error } = await db.getClaimsByUserId(userId!);
    // gh-1562 fixup: same leak class as getContractorById above.
    if (error) return unexpectedErrorResponse(error);
    if (!claims || claims.length === 0) {
      return jsonError(403, "Forbidden: user owns no claims");
    }
    if (!claims.every((c) => c.is_test === true)) {
      return jsonError(403, "Forbidden: not every claim owned by user is is_test");
    }

    const { data: authUser, error: authErr } = await db.getAuthUserById(userId!);
    // gh-1562 fixup: same leak class as getContractorById above.
    if (authErr) return unexpectedErrorResponse(authErr);
    if (!authUser || !authUser.email) {
      return jsonError(404, "Auth user not found");
    }
    targetUserId = userId!;
    targetEmail = authUser.email;
  }

  const { data: link, error: linkError } = await db.generateMagicLink(targetEmail);
  // gh-1562 fixup: same leak class as getContractorById above — this branch
  // used to return linkError.message verbatim. The no-action_link-without-
  // an-error edge case (adapter returned ok but no link) still gets logged
  // with its own distinguishing message server-side, not silently merged
  // into a generic "error" object with nothing to grep for.
  if (linkError || !link?.action_link) {
    return unexpectedErrorResponse(
      linkError ?? new Error("generateMagicLink returned no action_link"),
    );
  }

  const { error: logError } = await db.insertActivityLog({
    user_id: targetUserId,
    event_type: "test_session_minted",
    title: `Test session minted for ${targetEmail}`,
    is_test: true,
    metadata: {
      actor: actorEmail,
      target_user_id: targetUserId,
      contractor_id: resolvedContractorId,
    },
  });
  if (logError) {
    console.error(
      "[mint-test-session] activity_log insert failed (non-fatal):",
      logError.message,
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      action_link: link.action_link,
      user_id: targetUserId,
      email: targetEmail,
      is_test: true,
      expires_in: MAGIC_LINK_EXPIRES_IN,
    },
  };
}

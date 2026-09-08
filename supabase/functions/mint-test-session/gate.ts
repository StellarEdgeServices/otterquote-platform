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
//
// gh-1513 cross-table fix (#1773 forensics, 2026-09-07): a single table's
// is_test column is not a safe inference on its own — measured on
// production, `profiles.is_test` and `contractors.is_test` disagree for 8 of
// 13 rows this gate would otherwise mint against, and one such row's
// `contractors.user_id` resolves to the PRIMARY ADMIN account while its
// `contractors.email` column resolves (via GoTrue's own email-keyed lookup
// inside generateLink) to a *different* auth user entirely. So this gate now
// requires (a) agreement between the target's own is_test flag AND its
// linked `profiles.is_test`, and (b) the magic link is generated for the
// email GoTrue itself reports for the resolved auth user id — never for a
// caller-supplied or joined-table email column that might describe a
// different identity than the one actually being minted for.

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

export interface ProfileRow {
  id: string;
  is_test: boolean | null;
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
  getProfileById(
    userId: string,
  ): Promise<{ data: ProfileRow | null; error: AdapterError | null }>;
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
 * getProfileById, getAuthUserById, generateMagicLink — gh-1562 fixup, PR
 * #1563 review: these were still shipping raw adapter error text after the
 * first pass). This is a credential-minting endpoint, so error detail — a
 * message, a stack, PostgREST/driver text — can leak internal structure to
 * whoever can reach it. The function has no Sentry init, so console.error is
 * the only server-side detail sink; the response body is always the same
 * fixed, generic string — never error.message, error.stack, or String(error).
 */
export function unexpectedErrorResponse(error: unknown): MintResult {
  console.error("mint-test-session error:", error);
  return jsonError(500, "Internal server error");
}

/**
 * Cross-table agreement check (gh-1513 cross-table fix). A target's own
 * table saying is_test=true is necessary but not sufficient — the linked
 * profiles row must agree. A missing profiles row or a false/null
 * profiles.is_test is a refusal, never a default, matching the "null is a
 * refusal, not a default" rule this gate already applies to its own column.
 */
async function profileAgreesIsTest(
  db: DbAdapter,
  userId: string,
): Promise<{ ok: true } | { ok: false; result: MintResult }> {
  const { data: profile, error } = await db.getProfileById(userId);
  if (error) return { ok: false, result: unexpectedErrorResponse(error) };
  if (!profile) {
    return {
      ok: false,
      result: jsonError(403, "Forbidden: target has no profiles row"),
    };
  }
  if (profile.is_test !== true) {
    return {
      ok: false,
      result: jsonError(
        403,
        "Forbidden: profiles.is_test disagrees with the target's own is_test flag",
      ),
    };
  }
  return { ok: true };
}

/**
 * Core R-174 gate + mint logic.
 *
 * Input: exactly one of contractor_id | user_id (non-empty string).
 *   - contractor_id: 403 unless contractors.is_test is literally true for
 *     that row AND the linked profiles row also has is_test = true (cross-
 *     table agreement, gh-1513 fix). Target is the contractor's linked auth
 *     user (user_id).
 *   - user_id: 403 unless the user owns at least one claim AND every claim
 *     they own has is_test = true, AND the linked profiles row also has
 *     is_test = true. Target is that user_id directly.
 *
 * On success, resolves the target's email from the auth user record itself
 * (never from a joined table's email column, which is not guaranteed to
 * describe the same identity as the resolved user id — gh-1513 cross-table
 * fix), mints a Supabase magic link for that email via db.generateMagicLink,
 * writes a non-fatal activity_log row (event_type: "test_session_minted",
 * actor = caller identity in metadata, target = user_id), and returns the
 * { ok, action_link, user_id, email, is_test: true, expires_in } shape.
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
    targetUserId = userId!;
  }

  // gh-1513 cross-table fix: the target's own table said is_test=true; the
  // linked profiles row must agree before anything is minted.
  const agreement = await profileAgreesIsTest(db, targetUserId);
  if (!agreement.ok) return agreement.result;

  // gh-1513 cross-table fix: resolve the mint email from the auth user
  // record itself, never from contractors.email or any other joined
  // column — those are not guaranteed to describe the same identity as the
  // auth user id being minted for (measured: one production contractor row
  // whose user_id names the primary admin but whose email column resolves,
  // via GoTrue's own email lookup, to a different auth user entirely).
  const { data: authUser, error: authErr } = await db.getAuthUserById(targetUserId);
  // gh-1562 fixup: same leak class as getContractorById above.
  if (authErr) return unexpectedErrorResponse(authErr);
  if (!authUser || !authUser.email) {
    return jsonError(404, "Auth user not found");
  }
  const targetEmail = authUser.email;

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

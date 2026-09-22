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
//
// CTO36-B1513 / gh-2047 (2026-09-22): the cross-table check above stopped
// discriminating the three real companies gh-2047 identifies BY NAME
// ("is_test means two different things" — synthetic data vs. "real
// company, don't email yet") — a later, unrelated sync brought every
// profiles.is_test row into agreement with its linked contractors.is_test
// row, including these three (verified live, production, 2026-09-22: Indy
// Rooftops and both Stohler Roofing rows now read contractors.is_test=true
// AND profiles.is_test=true). Until gh-2047's own reclassification lands
// (Tier C, pending Dustin), this gate also refuses the three specific rows
// gh-2047 names, by id, regardless of what any is_test column reads — see
// KNOWN_MISFLAGGED_REAL_ACCOUNTS below. That is a stopgap for the KNOWN
// instances, not a structural fix for the general overload.

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
 * gh-2047 denylist (CTO36-B1513, 2026-09-22): `contractors.is_test` is
 * overloaded — per #2047 ("is_test means two different things") it also
 * marks a small number of REAL companies that were flagged `is_test = true`
 * purely to suppress product-notification email, not because the row is
 * synthetic data. The `profiles.is_test` cross-table check (gh-1513 cross-
 * table fix, above) was built to catch exactly this kind of disagreement,
 * but as of this fix it no longer does for these three rows — a later,
 * unrelated sync brought every `profiles.is_test` row into agreement with
 * its linked `contractors.is_test` row. Verified live, production,
 * 2026-09-22 (SELECT only): all three below read `contractors.is_test =
 * true` AND `profiles.is_test = true`.
 *
 * These are the exact three rows #2047 names by id/email:
 *   - Indy Rooftops, LLC        (contractors.id 5ece9e69…, #2047 body)
 *   - Stohler Roofing, LLC (#1) (contractors.id 8e90ff23…, #2047 body)
 *   - Stohler Roofing, LLC (#2) (contractors.id ee452a12…; its user_id is
 *     the PRIMARY ADMIN's own auth user — also named in #1773's forensics)
 *
 * Both the contractor row id and its linked auth-user id are listed, so
 * this refuses on either the `contractor_id` path or a direct `user_id`
 * path that happens to resolve to the same identity.
 *
 * This is a STOPGAP for the KNOWN instances of the #2047 overload, not a
 * fix for its general cause: a new real signup flagged `is_test = true`
 * tomorrow, for the same notification-suppression reason, would NOT be
 * caught by this list. The durable fix is #2047's own reclassification
 * (flip these — and only these, once verified — rows to `is_test = false`
 * + `notifications_suppressed = true`, currently Tier C / pending Dustin);
 * once that lands, `is_test` alone becomes trustworthy again and this list
 * should be deleted rather than extended. Flagged as an open question on
 * gh-1513's PR and issue comment rather than silently assumed.
 */
export const KNOWN_MISFLAGGED_REAL_ACCOUNTS: ReadonlySet<string> = new Set([
  // Indy Rooftops, LLC — real contractor, #2047
  "5ece9e69-91f8-48cd-b4fa-412dec4f8dee", // contractors.id
  "edcbe10f-7efa-4945-be3b-5c3e4ef8f2e2", // contractors.user_id / profiles.id
  // Stohler Roofing, LLC (row 1) — real contractor, #2047
  "8e90ff23-3894-4f67-9ca7-58a044cd986b", // contractors.id
  "e371c617-8a24-492e-9911-47c85705ebb4", // contractors.user_id / profiles.id
  // Stohler Roofing, LLC (row 2) — real contractor; user_id is the PRIMARY
  // ADMIN's own auth user (#2047, #1773 forensics)
  "ee452a12-c16e-4d30-9d2c-df8128fbce52", // contractors.id
  "3ea4d929-b916-4cc9-a285-d052df397992", // contractors.user_id / profiles.id
]);

function knownRealAccountRefusal(): MintResult {
  return jsonError(
    403,
    "Forbidden: target is a known real account misflagged is_test (see #2047) — refused regardless of is_test",
  );
}

/**
 * Pure parse of the caller's Authorization header. Extracted from index.ts
 * (CTO36-B1513) so the "missing/invalid Authorization header -> 401" path
 * has a negative-control unit test that doesn't require a live
 * serve()/fetch listener. Returns the bearer token, or null if the header
 * is absent or not a well-formed "Bearer <token>" value.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
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

  // gh-2047 denylist (CTO36-B1513): refused on identity alone, before the
  // cross-table check even runs — these three rows are known to pass BOTH
  // is_test columns as of 2026-09-22 (see KNOWN_MISFLAGGED_REAL_ACCOUNTS'
  // doc comment), so the cross-table check alone can no longer be trusted
  // to stop them.
  if (
    KNOWN_MISFLAGGED_REAL_ACCOUNTS.has(targetUserId) ||
    (resolvedContractorId !== null &&
      KNOWN_MISFLAGGED_REAL_ACCOUNTS.has(resolvedContractorId))
  ) {
    return knownRealAccountRefusal();
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

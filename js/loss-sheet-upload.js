/**
 * Shared loss-sheet upload helper.
 *
 * gh-2070: trade-selector.html's "Upload Your Loss Sheet" stub uploaded the
 * file to `claim-documents` and then did nothing — no claims.has_estimate /
 * estimate_filename write-back, no parse-loss-sheet invoke, so the file never
 * showed up in the admin loss-sheet queue. dashboard.html's checklist upload
 * already did this correctly. This module is the single implementation both
 * pages call, so the two upload UIs cannot diverge again.
 *
 * Storage key convention: `{user.id}/{claim.id}/{timestamp}-{filename}`.
 *
 * trade-selector's insurance step runs the upload BEFORE the claim row
 * exists (the claim is only created/updated in completeSelection()). In that
 * case the file is staged under `{user.id}/loss-sheets/{timestamp}-{filename}`
 * and the reference is persisted to sessionStorage; call
 * attachPendingLossSheet() right after the claim id is known (immediately
 * after the claims insert/update) to move the object onto the canonical
 * `{user}/{claim}/…` key, write back has_estimate/estimate_filename, and
 * invoke parse-loss-sheet.
 */
(function (global) {
  const BUCKET = 'claim-documents';
  const PENDING_KEY = 'oq_pending_loss_sheet';

  function claimPath(userId, claimId, filename) {
    return `${userId}/${claimId}/${Date.now()}-${filename}`;
  }

  // Writes claims.has_estimate / claims.estimate_filename for an already
  // Supabase-uploaded storage path, then invokes parse-loss-sheet so
  // rcv_amount / acv_amount get populated. Mirrors dashboard.html's
  // estimate-upload path (gh-2070 / F-005).
  async function writeBackAndParse({ sb, claimId, storagePath }) {
    const { error: updateError } = await sb
      .from('claims')
      .update({
        has_estimate: true,
        estimate_filename: storagePath,
      })
      .eq('id', claimId);

    if (updateError) throw updateError;

    try {
      await sb.functions.invoke('parse-loss-sheet', {
        body: {
          claim_id: claimId,
          storage_path: storagePath,
        },
      });
    } catch (parseErr) {
      // Non-fatal — parsing failure doesn't block the upload (matches
      // dashboard.html's existing parse-loss-sheet handling).
      console.warn('[loss-sheet-upload] parse-loss-sheet failed (non-fatal):', parseErr);
    }
  }

  function savePending(record) {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(record));
    } catch (_) {
      // sessionStorage unavailable (private mode, etc) — the upload itself
      // still succeeded, it just won't auto-attach later.
    }
  }

  function readPending() {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function clearPending() {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch (_) {}
  }

  /**
   * Uploads a loss sheet file to Supabase Storage and, when a claim id is
   * already known, writes it back to the claim and triggers parsing.
   *
   * @param {Object} opts
   * @param {Object} opts.sb - the Supabase client
   * @param {Object} opts.user - the authenticated user ({ id, ... })
   * @param {string|null} opts.claimId - the claim id, if known yet
   * @param {File} opts.file - the file to upload
   * @returns {Promise<{storagePath: string, pending: boolean}>}
   */
  async function uploadLossSheet({ sb, user, claimId, file }) {
    if (!sb || !user) {
      throw new Error('Not authenticated');
    }

    if (claimId) {
      const storagePath = claimPath(user.id, claimId, file.name);
      const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(storagePath, file, { upsert: true });
      if (uploadError) throw uploadError;

      await writeBackAndParse({ sb, claimId, storagePath });
      return { storagePath, pending: false };
    }

    // No claim yet (e.g. trade-selector's insurance step, ahead of claim
    // creation) — stage the upload and remember it so it can be attached
    // once the claim row exists.
    const stagingPath = `${user.id}/loss-sheets/${Date.now()}-${file.name}`;
    const { error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(stagingPath, file, { upsert: true });
    if (uploadError) throw uploadError;

    savePending({ storagePath: stagingPath, filename: file.name, userId: user.id });
    return { storagePath: stagingPath, pending: true };
  }

  /**
   * Call right after a claim id becomes known (immediately after the claims
   * insert/update) to move any loss sheet uploaded before that point onto
   * the canonical `{user}/{claim}/…` key and write it back to the claim.
   * No-op if nothing is pending. Never throws — failures are non-fatal so
   * they never block navigation.
   *
   * @returns {Promise<string|null>} the final storage path, or null
   */
  async function attachPendingLossSheet({ sb, user, claimId }) {
    if (!sb || !user || !claimId) return null;

    const pending = readPending();
    if (!pending || !pending.storagePath) return null;
    if (pending.userId && pending.userId !== user.id) return null;

    const finalPath = claimPath(
      user.id,
      claimId,
      pending.filename || pending.storagePath.split('/').pop()
    );

    try {
      const { error: moveError } = await sb.storage
        .from(BUCKET)
        .move(pending.storagePath, finalPath);
      if (moveError) throw moveError;

      await writeBackAndParse({ sb, claimId, storagePath: finalPath });
      clearPending();
      return finalPath;
    } catch (err) {
      console.warn('[loss-sheet-upload] attachPendingLossSheet failed (non-fatal):', err);
      return null;
    }
  }

  global.LossSheetUpload = {
    BUCKET,
    uploadLossSheet,
    attachPendingLossSheet,
    writeBackAndParse,
  };
})(window);

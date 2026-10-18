/**
 * VideoUploadManager — OtterQuote
 * Handles video uploads for damage walkthrough clips.
 * Uses direct Supabase client (sb) — no Edge Functions required.
 * Storage bucket: claim-documents
 * Path pattern: videos/{user_id}/{claim_id}/{timestamp}.{ext}
 * DB: claims.video_url = storage path
 */

class VideoUploadManager {
  constructor(claimId, userId) {
    this.claimId = claimId;
    this.userId = userId;
    this.maxSizeBytes = 250 * 1024 * 1024; // 250 MB
    this.maxDurationSec = 60;
    this.allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
    this.allowedExtensions = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
  }

  /**
   * Validate file type, size, and duration.
   * Returns { valid: true } or { valid: false, error: string }
   */
  async validate(file) {
    if (!this.allowedTypes.includes(file.type)) {
      return { valid: false, error: 'Unsupported format. Please upload MP4, MOV, or WebM.' };
    }
    if (file.size > this.maxSizeBytes) {
      const mb = (file.size / 1024 / 1024).toFixed(0);
      return { valid: false, error: `File too large (${mb} MB). Maximum is 250 MB.` };
    }
    try {
      const duration = await this._getDuration(file);
      if (duration > this.maxDurationSec) {
        return { valid: false, error: `Video is ${Math.round(duration)}s — maximum is ${this.maxDurationSec}s.` };
      }
    } catch (_) {
      // Duration check non-fatal — proceed
    }
    return { valid: true };
  }

  /**
   * Upload file to Supabase storage and record path in claims table.
   * Requires global `sb` (Supabase client) to be initialised.
   * Returns { success: true, path: string } or { success: false, error: string }
   */
  async upload(file) {
    if (typeof sb === 'undefined') {
      return { success: false, error: 'Supabase client not initialised.' };
    }
    const ext = this.allowedExtensions[file.type] || 'mp4';
    const filePath = `videos/${this.userId}/${this.claimId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await sb.storage
      .from('claim-documents')
      .upload(filePath, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      console.error('[VideoUploadManager] storage error:', uploadError);
      return { success: false, error: uploadError.message || 'Upload failed.' };
    }

    // gh-2105 class (a): `.select('id')` so a zero-row match is a failure, not a silent success.
    const { data: dbRows, error: dbError } = await sb
      .from('claims')
      .update({ video_url: filePath })
      .eq('id', this.claimId)
      .select('id');

    if (dbError || !dbRows || dbRows.length === 0) {
      console.error('[VideoUploadManager] db error:', dbError || 'update matched 0 rows');
      // Storage succeeded — don't surface a fatal error, but log it
      return { success: true, path: filePath, warning: 'Saved to storage but failed to record in database.' };
    }

    return { success: true, path: filePath };
  }

  /**
   * Convenience: validate then upload. Returns same shape as upload().
   */
  async validateAndUpload(file) {
    const v = await this.validate(file);
    if (!v.valid) return { success: false, error: v.error };
    return this.upload(file);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _getDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); };
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('metadata load failed')); };
      video.src = url;
    });
  }
}

// Expose globally for use by dashboard.html inline handlers
window.VideoUploadManager = VideoUploadManager;

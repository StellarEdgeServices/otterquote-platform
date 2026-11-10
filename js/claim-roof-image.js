/**
 * gh-1413 / D-317 cl. 6: homeowner-only aerial image of the claim area (USGS NAIP), shown on bids.html.
 * FEATURE FLAG: ROOF_IMAGE_ENABLED is false by default. While false this file does nothing: no function call, no storage call, no DOM change.
 * When true: asks the fetch-roof-image Edge Function (caller's own JWT, claim owner only) to create the image if it is missing,
 * then reads it from the private claim-roof-images bucket through a signed URL. The bucket's only SELECT policy is the homeowner's.
 * Contractors have NO access (D-371 / D-368 / Contractor Agreement 6.2): this file is not loaded on any contractor page.
 * Credit line (required by this product, not by USGS): "Imagery: USDA/USGS NAIP".
 */
(function () {
  'use strict';
  var ROOF_IMAGE_ENABLED = false;
  var ATTRIBUTION = 'Imagery: USDA/USGS NAIP';
  var ALT_TEXT = 'Aerial image of the area around the claim address (USDA/USGS NAIP; imagery date varies)';
  window.OQRoofImage = {
    ATTRIBUTION: ATTRIBUTION,
    ALT_TEXT: ALT_TEXT,
    render: async function (sb, claimId, containerId) {
      if (!ROOF_IMAGE_ENABLED || !sb || !claimId) return false;
      var el = document.getElementById(containerId);
      if (!el) return false;
      try {
        // Create the image if missing (idempotent; the function returns the current object path).
        var inv = await sb.functions.invoke('fetch-roof-image', { body: { claim_id: claimId } });
        var path = inv && inv.data && inv.data.path;
        if (inv.error || typeof path !== 'string' || path.indexOf(claimId + '/') !== 0) return false; // not created: show nothing
        var r = await sb.storage.from('claim-roof-images').createSignedUrl(path, 300);
        if (r.error || !r.data || !r.data.signedUrl) return false; // not permitted: show nothing
        var fig = document.createElement('figure');
        fig.style.cssText = 'margin:0 0 1rem 0;';
        var img = document.createElement('img');
        img.src = r.data.signedUrl;
        img.alt = ALT_TEXT;
        img.style.cssText = 'width:100%;max-width:600px;border-radius:8px;display:block;';
        var cap = document.createElement('figcaption');
        cap.textContent = ATTRIBUTION;
        cap.style.cssText = 'font-size:0.75rem;color:#64748B;margin-top:0.25rem;';
        fig.appendChild(img); fig.appendChild(cap);
        el.innerHTML = ''; el.appendChild(fig);
        return true;
      } catch (e) { return false; }
    }
  };
})();

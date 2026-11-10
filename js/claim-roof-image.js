/**
 * gh-1413 / D-317 cl. 6: renders the stored NAIP roof image for a claim.
 * FEATURE FLAG: ROOF_IMAGE_ENABLED is false by default. While false this file does nothing (no request, no DOM change).
 * The image is read from the private claim-roof-images bucket at {claim_id}/roof.jpg via a signed URL; the bucket's
 * SELECT policies (draft migration gh1413_claim_roof_images_bucket.sql, NOT applied) decide who can read it.
 * Credit line (required by this product, not by USGS): "Imagery: USDA/USGS NAIP".
 */
(function () {
  'use strict';
  var ROOF_IMAGE_ENABLED = false;
  var ATTRIBUTION = 'Imagery: USDA/USGS NAIP';
  window.OQRoofImage = {
    ATTRIBUTION: ATTRIBUTION,
    render: async function (sb, claimId, containerId) {
      if (!ROOF_IMAGE_ENABLED || !sb || !claimId) return false;
      var el = document.getElementById(containerId);
      if (!el) return false;
      try {
        var r = await sb.storage.from('claim-roof-images').createSignedUrl(claimId + '/roof.jpg', 300);
        if (r.error || !r.data || !r.data.signedUrl) return false; // no image stored or not permitted: show nothing
        var fig = document.createElement('figure');
        fig.style.cssText = 'margin:0 0 1rem 0;';
        var img = document.createElement('img');
        img.src = r.data.signedUrl;
        img.alt = 'Aerial view of the roof at the claim address';
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

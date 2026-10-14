'use client';

/**
 * Home Photos card (D-211 Phase 7 / BF-2 — port of contractor-bid-form.html
 * initHoverHomePhotos/renderHoverPhotos, :2761-2900).
 *
 * gh-1873: the measurement vendor (Hover) is retired. The card no longer calls any back-end function and shows
 * its empty state ("No property photos are available for this project yet."). The thumbnail grid and lightbox
 * stay in place for a replacement photo source.
 */

import { useState } from 'react';
import { Card } from './bid-ui';

interface PhotoPayload {
  ts: number;
  images: string[];
  hover_job_id: string | null;
  job_address: string | null;
}

// gh-1873: the measurement vendor (Hover) is retired. No back-end function is called; the card is always in its empty
// state, and a cached vendor payload from an earlier visit is never rendered.
const EMPTY_PAYLOAD: PhotoPayload = { ts: 0, images: [], hover_job_id: null, job_address: null };

export function HomePhotosCard({ claimId: _claimId, isSiding: _isSiding }: { claimId: string; isSiding: boolean }) {
  const payload = EMPTY_PAYLOAD;
  const loading = false;
  const [lightbox, setLightbox] = useState<number | null>(null);

  const images = payload?.images ?? [];

  return (
    <Card title="Home Photos" sub="Reference imagery from the measurement for this property.">

      {loading && <div className="oqb-summary-k">Loading photos…</div>}

      {!loading && images.length === 0 && (
        <div className="oqb-summary-k">No property photos are available for this project yet.</div>
      )}

      {!loading && images.length > 0 && (
        <>
          <div className="oqb-photos-grid">
            {images.slice(0, 4).map((url, i) => (
              <img key={i} src={url} alt={'Property view ' + (i + 1)} loading="lazy" onClick={() => setLightbox(i)} />
            ))}
          </div>
          {images.length > 4 && (
            <div className="oqb-photos-more">+ {images.length - 4} more photos — click any photo to browse all</div>
          )}
        </>
      )}

      {lightbox !== null && images[lightbox] && (
        <div className="oqb-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <button className="oqb-lb-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>✕</button>
          {images.length > 1 && (
            <button className="oqb-lb-prev" aria-label="Previous"
              onClick={(e) => { e.stopPropagation(); setLightbox((lightbox - 1 + images.length) % images.length); }}>‹</button>
          )}
          <img src={images[lightbox]} alt={'Property view ' + (lightbox + 1)} onClick={(e) => e.stopPropagation()} />
          {images.length > 1 && (
            <button className="oqb-lb-next" aria-label="Next"
              onClick={(e) => { e.stopPropagation(); setLightbox((lightbox + 1) % images.length); }}>›</button>
          )}
        </div>
      )}
    </Card>
  );
}

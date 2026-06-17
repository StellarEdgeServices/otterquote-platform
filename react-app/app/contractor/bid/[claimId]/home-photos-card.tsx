'use client';

/**
 * Home Photos card (D-211 Phase 7 / BF-2 — port of contractor-bid-form.html
 * initHoverHomePhotos/renderHoverPhotos, :2761-2900). Reads the get-hover-siding-data
 * EF (UNCHANGED contract) for the claim's Hover design images, caches them in
 * sessionStorage (10-min TTL, key hover_photos_<claimId>), renders a 4-up thumbnail
 * grid + lightbox, and (siding claims only) an "Open Hover 3D Design" link.
 *
 * Tier-3 note: get-hover-siding-data is called with its existing { claim_id } contract.
 * Its missing caller-auth/ownership (IDOR) finding is filed for migration-author
 * (ClickUp 86e1xe0wb) — NOT addressed here.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card } from './bid-ui';

const HOVER_PHOTOS_TTL = 10 * 60 * 1000;

interface PhotoPayload {
  ts: number;
  images: string[];
  hover_job_id: string | null;
  job_address: string | null;
}

function readCache(claimId: string): PhotoPayload | null {
  try {
    const raw = sessionStorage.getItem('hover_photos_' + claimId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PhotoPayload;
    if (Date.now() - parsed.ts < HOVER_PHOTOS_TTL) return parsed;
  } catch { /* ignore */ }
  return null;
}

export function HomePhotosCard({ claimId, isSiding }: { claimId: string; isSiding: boolean }) {
  const [payload, setPayload] = useState<PhotoPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    if (!claimId) return;
    let active = true;
    const cached = readCache(claimId);
    if (cached) { setPayload(cached); setLoading(false); return; }

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('get-hover-siding-data', { body: { claim_id: claimId } });
        if (!active) return;
        if (error) throw error;
        const next: PhotoPayload = {
          ts: Date.now(),
          images: (data?.design_images as string[]) || [],
          hover_job_id: (data?.hover_job_id as string) || null,
          job_address: (data?.job_address as string) || null,
        };
        try { sessionStorage.setItem('hover_photos_' + claimId, JSON.stringify(next)); } catch { /* ignore */ }
        setPayload(next);
      } catch (err) {
        console.warn('[Home Photos] fetch error:', err);
        if (active) setPayload({ ts: Date.now(), images: [], hover_job_id: null, job_address: null });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [claimId]);

  const images = payload?.images ?? [];
  const jobUrl = payload?.hover_job_id ? 'https://hover.to/jobs/' + payload.hover_job_id : null;

  return (
    <Card title="Home Photos" sub="Reference imagery from the Hover measurement for this property.">
      {payload?.job_address && <div className="oqb-summary-k" style={{ marginBottom: '0.5rem' }}>{payload.job_address}</div>}

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

      <div className="oqb-doclinks">
        {jobUrl && isSiding && (
          <a className="oqb-doclink" href={jobUrl} target="_blank" rel="noreferrer">Open Hover 3D Design</a>
        )}
        {jobUrl && (
          <a className="oqb-doclink" href={jobUrl} target="_blank" rel="noreferrer">View on Hover</a>
        )}
      </div>

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

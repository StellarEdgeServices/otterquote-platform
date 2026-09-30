/**
 * gh-2060 — stale-state coverage for the contractor bid page's sessionStorage
 * caches: `hover_photos_<claimId>` (home-photos-card.tsx) and
 * `d202_warranty_options` / `d202_warranty_options_at` (warranty-card.tsx).
 *
 * Both are read-through caches with a TTL. The stale-state questions are:
 *   - does a cache entry left for a DIFFERENT claim get shown on this one?
 *   - does an entry past its TTL get trusted instead of refetched?
 *   - does a fresh entry still short-circuit the network (positive control)?
 * Each test seeds the dirty state with `seedStaleStorage()` after this file's
 * own clean `beforeEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

const invokeMock = vi.fn();
const warrantyRows = vi.fn();

function makeBuilder(table: string) {
  const result = () => {
    if (table === 'warranty_options') return { data: warrantyRows(), error: null };
    return { data: null, error: null };
  };
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'eq']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve({ data: null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (table: string) => makeBuilder(table),
  },
}));

import { HomePhotosCard } from '../home-photos-card';
import { WarrantyCard } from '../warranty-card';

const TEN_MIN = 10 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

function photosPayload(imgs: string[], ts: number) {
  return JSON.stringify({ ts, images: imgs, hover_job_id: null, job_address: null });
}

describe('hover_photos_<claimId> — stale sessionStorage cache (home-photos-card.tsx)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    invokeMock.mockReset();
  });
  afterEach(cleanup);

  it("does not show another claim's cached photos on this claim - it fetches its own", async () => {
    invokeMock.mockResolvedValue({ data: { design_images: ['https://img.test/mine.jpg'] }, error: null });
    seedStaleStorage({
      sessionStorage: { hover_photos_claim_other: photosPayload(['https://img.test/other.jpg'], Date.now()) },
    });
    render(<HomePhotosCard claimId="claim_mine" isSiding={false} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('get-hover-siding-data', { body: { claim_id: 'claim_mine' } });
    const img = await screen.findByAltText('Property view 1');
    expect(img.getAttribute('src')).toBe('https://img.test/mine.jpg');
  });

  it('refetches when this claim cache entry is past the 10-minute TTL', async () => {
    invokeMock.mockResolvedValue({ data: { design_images: ['https://img.test/new.jpg'] }, error: null });
    seedStaleStorage({
      sessionStorage: { hover_photos_claim_mine: photosPayload(['https://img.test/old.jpg'], Date.now() - TEN_MIN - 1000) },
    });
    render(<HomePhotosCard claimId="claim_mine" isSiding={false} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const img = await screen.findByAltText('Property view 1');
    expect(img.getAttribute('src')).toBe('https://img.test/new.jpg');
  });

  it('a FUTURE-dated entry (negative age) is not "fresh" - it is refetched, not trusted (gh-2060 item 7)', async () => {
    invokeMock.mockResolvedValue({ data: { design_images: ['https://img.test/new.jpg'] }, error: null });
    seedStaleStorage({
      sessionStorage: { hover_photos_claim_mine: photosPayload(['https://img.test/future.jpg'], Date.now() + 24 * 60 * 60 * 1000) },
    });
    render(<HomePhotosCard claimId="claim_mine" isSiding={false} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const img = await screen.findByAltText('Property view 1');
    expect(img.getAttribute('src')).toBe('https://img.test/new.jpg');
  });

  it('a cache entry with no timestamp (older app version shape) is not trusted', async () => {
    invokeMock.mockResolvedValue({ data: { design_images: [] }, error: null });
    seedStaleStorage({ sessionStorage: { hover_photos_claim_mine: JSON.stringify({ images: ['https://img.test/legacy.jpg'] }) } });
    render(<HomePhotosCard claimId="claim_mine" isSiding={false} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText('Property view 1')).toBeNull();
  });

  it('POSITIVE CONTROL: a fresh entry for this claim is used without a network call', async () => {
    seedStaleStorage({
      sessionStorage: { hover_photos_claim_mine: photosPayload(['https://img.test/cached.jpg'], Date.now() - 1000) },
    });
    render(<HomePhotosCard claimId="claim_mine" isSiding={false} />);
    const img = await screen.findByAltText('Property view 1');
    expect(img.getAttribute('src')).toBe('https://img.test/cached.jpg');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('d202_warranty_options - stale sessionStorage cache (warranty-card.tsx)', () => {
  const row = (manufacturer: string) => ({
    id: `id-${manufacturer}`, manufacturer, tier: 'Std', material_years: 25, labor_years: 10, labor_note: null,
    tearoff_years: null, wind_mph: 110, hail_class: null, cert_required: null, display_string: `${manufacturer} Std`,
  });

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    warrantyRows.mockReset();
  });
  afterEach(cleanup);

  it('a catalog cached more than 5 minutes ago is NOT trusted - the fresh catalog is fetched and shown', async () => {
    warrantyRows.mockReturnValue([row('FreshMfr')]);
    seedStaleStorage({
      sessionStorage: {
        d202_warranty_options: JSON.stringify([row('StaleMfr')]),
        d202_warranty_options_at: String(Date.now() - FIVE_MIN - 1000),
      },
    });
    render(<WarrantyCard contractorId={null} onChange={() => undefined} />);
    expect(await screen.findByText('FreshMfr')).toBeTruthy();
    expect(screen.queryByText('StaleMfr')).toBeNull();
    // and the refreshed catalog replaced the stale one in storage
    expect(sessionStorage.getItem('d202_warranty_options')).toContain('FreshMfr');
  });

  it('a FUTURE-dated catalog stamp (negative age) is not "fresh" - the catalog is refetched (gh-2060 item 7)', async () => {
    warrantyRows.mockReturnValue([row('FreshMfr')]);
    seedStaleStorage({
      sessionStorage: {
        d202_warranty_options: JSON.stringify([row('StaleMfr')]),
        d202_warranty_options_at: String(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    render(<WarrantyCard contractorId={null} onChange={() => undefined} />);
    expect(await screen.findByText('FreshMfr')).toBeTruthy();
    expect(screen.queryByText('StaleMfr')).toBeNull();
  });

  it('a cached catalog with no timestamp (older app version) is not trusted', async () => {
    warrantyRows.mockReturnValue([row('FreshMfr')]);
    seedStaleStorage({ sessionStorage: { d202_warranty_options: JSON.stringify([row('StaleMfr')]) } });
    render(<WarrantyCard contractorId={null} onChange={() => undefined} />);
    expect(await screen.findByText('FreshMfr')).toBeTruthy();
    expect(screen.queryByText('StaleMfr')).toBeNull();
  });

  it('POSITIVE CONTROL: a catalog cached seconds ago is used without hitting the database', async () => {
    warrantyRows.mockReturnValue([row('ShouldNotBeFetched')]);
    seedStaleStorage({
      sessionStorage: {
        d202_warranty_options: JSON.stringify([row('CachedMfr')]),
        d202_warranty_options_at: String(Date.now() - 1000),
      },
    });
    render(<WarrantyCard contractorId={null} onChange={() => undefined} />);
    expect(await screen.findByText('CachedMfr')).toBeTruthy();
    expect(screen.queryByText('ShouldNotBeFetched')).toBeNull();
  });
});

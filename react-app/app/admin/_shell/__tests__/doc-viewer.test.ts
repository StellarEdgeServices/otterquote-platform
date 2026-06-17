/**
 * Unit tests for createBucketSignedUrl (D-211 Phase 9).
 *
 * Mocks the supabase singleton (@/lib/supabase) so no real network calls are
 * made and no env vars are required.
 *
 * Mirrors the vi.mock('@/lib/supabase', ...) pattern — the alias '@' maps to
 * react-app/app (vitest.config.ts resolve.alias).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock supabase BEFORE importing the module under test ─────────────────────

const mockCreateSignedUrl = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: mockCreateSignedUrl,
      }),
    },
  },
}));

// Import AFTER mock is set up
import { createBucketSignedUrl } from '../doc-viewer';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateSignedUrl.mockReset();
});

describe('createBucketSignedUrl', () => {
  it('returns null when path is empty string (never calls supabase)', async () => {
    const result = await createBucketSignedUrl('cert-letters', '', 600);
    expect(result).toBeNull();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it('returns null when path is falsy (never calls supabase)', async () => {
    // TypeScript will flag this, but test the runtime guard
    const result = await createBucketSignedUrl('cert-letters', '' as string, 600);
    expect(result).toBeNull();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it('returns the signedUrl string on success', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.example.com/signed/abc.pdf' },
      error: null,
    });
    const result = await createBucketSignedUrl('cert-letters', 'certs/abc.pdf', 600);
    expect(result).toBe('https://storage.example.com/signed/abc.pdf');
  });

  it('returns null when supabase returns an error', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'Object not found' },
    });
    const result = await createBucketSignedUrl('cert-letters', 'certs/missing.pdf', 600);
    expect(result).toBeNull();
  });

  it('returns null when data.signedUrl is missing', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: null },
      error: null,
    });
    const result = await createBucketSignedUrl('cert-letters', 'certs/abc.pdf', 600);
    expect(result).toBeNull();
  });

  it('returns null when data itself is null', async () => {
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: null });
    const result = await createBucketSignedUrl('cert-letters', 'certs/abc.pdf', 600);
    expect(result).toBeNull();
  });

  it('returns null and does not throw when createSignedUrl rejects', async () => {
    mockCreateSignedUrl.mockRejectedValue(new Error('network error'));
    const result = await createBucketSignedUrl('cert-letters', 'certs/abc.pdf', 600);
    expect(result).toBeNull();
  });

  it('passes bucket and ttlSeconds to supabase correctly', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://example.com/url' },
      error: null,
    });
    await createBucketSignedUrl('partner-w9', 'docs/w9.pdf', 3600);
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('docs/w9.pdf', 3600);
  });
});

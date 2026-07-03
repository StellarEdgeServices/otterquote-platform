'use client';

/**
 * Shared signed-doc viewer — D-211 Phase 9.
 *
 * Reusable across admin buckets: cert-letters, contractor-templates,
 * partner-w9, contractor-documents. Lazy — generates the signed URL
 * only on click, not on render.
 *
 * §6.1 XSS: no innerHTML / dangerouslySetInnerHTML. All paths
 * are handled by supabase.storage, not interpolated into the DOM.
 */

import { supabase } from '@/lib/supabase';

/**
 * Generate a signed URL for a Supabase Storage path.
 * Returns null on any error, empty/falsy path, or missing signedUrl.
 */
export async function createBucketSignedUrl(
  bucket: string,
  path: string,
  ttlSeconds: number,
): Promise<string | null> {
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Renders an anchor that lazily fetches a signed URL on click and opens it in
 * a new tab. Renders nothing if path is falsy (the page guards this already,
 * but the component is defensive).
 */
export function SignedDocLink({
  bucket,
  path,
  ttlSeconds,
  label,
  className,
}: {
  bucket: string;
  path: string;
  ttlSeconds: number;
  label: string;
  className?: string;
}): React.JSX.Element {
  if (!path) {
    return <></>;
  }

  async function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    const url = await createBucketSignedUrl(bucket, path, ttlSeconds);
    if (url) {
      window.open(url, '_blank');
    }
  }

  return (
    <a
      href="#"
      role="button"
      className={className}
      onClick={handleClick}
    >
      {label}
    </a>
  );
}

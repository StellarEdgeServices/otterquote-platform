'use client';

/**
 * gh-1983 — runs captureFirstTouch() once per page load on every React route,
 * so a tagged landing anywhere on app.otterquote.com is stored even if the
 * server-set cookie was dropped (see app/lib/attribution.ts).
 */

import { useEffect } from 'react';
import { captureFirstTouch } from '../lib/attribution';

export function AttributionCapture() {
  useEffect(() => {
    captureFirstTouch();
  }, []);
  return null;
}

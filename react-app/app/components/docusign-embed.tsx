'use client';

/**
 * <DocuSignEmbed> — reusable embedded-DocuSign signing surface (D-211 Phase 25, H3).
 *
 * A straight EXTRACTION of the proven embedded-signing pattern shared by the live
 * homeowner page (contract-signing.html, repo root) and the Phase-17 contractor
 * surface (react-app/app/contractor/sign/[claimId]/page.tsx) — NO new behavior:
 *
 *   create-docusign-envelope → result.signing_url → <iframe id="docusignFrame"> →
 *   window 'message' listener detects completion → onComplete().
 *
 * The host page resolves the envelope/URL and passes signing_url in; this component
 * owns only the iframe + the completion listener. There is NO DocuSign JS SDK and NO
 * client-side integration key — by design (kept that way).
 *
 * Completion is detected from THREE signals (verbatim from the references —
 * contract-signing.html:1617-1632 / contractor page.tsx:160-176):
 *   1. a JSON message  { type: 'session_end' }
 *   2. a JSON message  { event: 'signing_complete' }
 *   3. a non-JSON string containing 'signed=true' or 'signing_complete'
 *
 * The in-iframe RETURN view (the page rendered INSIDE the iframe on DocuSign's return
 * redirect) uses isSigningCompleteReturn() + runSigningReturnBridge() below to
 * postMessage the parent — mirroring contract-signing.html:1116-1125.
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

export interface DocuSignEmbedProps {
  /** Embedded signing URL returned by create-docusign-envelope (result.signing_url). */
  signingUrl: string;
  /** Fired once when any of the three completion signals is observed. */
  onComplete: () => void;
  /** Accessible iframe title. */
  title?: string;
}

// Self-contained frame styling (the reference embedded its equivalent inline at
// contract-signing.html:996 / via .oqs-frame in the contractor page) so the
// component does not depend on a host page injecting CSS.
const FRAME_STYLE: CSSProperties = {
  width: '100%',
  minHeight: 600,
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  background: '#fff',
};

export function DocuSignEmbed({
  signingUrl,
  onComplete,
  title = 'DocuSign contract signing',
}: DocuSignEmbedProps) {
  // Hold the latest onComplete in a ref so the listener subscribes ONCE and never
  // re-binds per render (matches the reference's onCompleteRef pattern).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    function handle(event: MessageEvent) {
      if (!event.data || typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'session_end' || data.event === 'signing_complete') {
          onCompleteRef.current();
        }
      } catch {
        // Not JSON — fall back to URL-substring detection (verbatim from the refs).
        if (event.data.includes('signed=true') || event.data.includes('signing_complete')) {
          onCompleteRef.current();
        }
      }
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, []);

  return (
    <iframe
      id="docusignFrame"
      title={title}
      src={signingUrl}
      allow="geolocation"
      style={FRAME_STYLE}
    />
  );
}

/**
 * True when a URLSearchParams marks a genuine signing-completion RETURN. The
 * homeowner return_url carries ?signed=true; DocuSign may also append
 * ?event=signing_complete. Verbatim from contract-signing.html:1119.
 * Cancel/decline carry a different event value, so they read false.
 */
export function isSigningCompleteReturn(search: URLSearchParams): boolean {
  return search.get('event') === 'signing_complete' || search.get('signed') === 'true';
}

type ParentPoster = { postMessage: (message: string, targetOrigin: string) => void };

/**
 * Post the parent-window completion signal the embedded-return view sends. Verbatim
 * payload shape from contract-signing.html:1120. Best-effort.
 */
export function postSigningCompleteToParent(target: ParentPoster = window.parent): void {
  try {
    target.postMessage(JSON.stringify({ type: 'session_end', event: 'signing_complete' }), '*');
  } catch {
    /* posting to the parent is best-effort; the parent also accepts URL fallbacks */
  }
}

interface ReturnBridgeWindow {
  self: unknown;
  top: unknown;
  location: { search: string };
  parent: ParentPoster;
}

/**
 * In-iframe-return bridge: when the host page is rendered INSIDE the DocuSign iframe
 * on the completion return, notify the parent window and report whether it fired.
 * Mirrors contract-signing.html:1116-1125. Returns true iff the bridge posted.
 * `win` is injectable so the iframe/no-iframe branches are unit-testable.
 */
export function runSigningReturnBridge(
  win: ReturnBridgeWindow = window as unknown as ReturnBridgeWindow,
): boolean {
  const inIframe = win.self !== win.top;
  const search = new URLSearchParams(win.location.search);
  if (inIframe && isSigningCompleteReturn(search)) {
    postSigningCompleteToParent(win.parent);
    return true;
  }
  return false;
}

// gh-2154 P-5 — Meta webhook verification handshake (GET).
//
// Meta's Graph API Webhooks "getting-started" doc: on subscribing, Meta
// sends a GET with hub.mode=subscribe, hub.verify_token=<your configured
// token>, hub.challenge=<int>. Echo hub.challenge back as plain text with
// 200 iff hub.mode is "subscribe" AND hub.verify_token matches the secret
// this project configured (META_LEADGEN_VERIFY_TOKEN). Anything else,
// including an unset verify token, is 403 — no challenge is ever echoed to
// an unrecognized caller.

export interface HandshakeResult {
  ok: boolean;
  challenge: string | null;
}

export function verifyHandshake(
  params: URLSearchParams,
  configuredVerifyToken: string | undefined,
): HandshakeResult {
  if (!configuredVerifyToken) return { ok: false, challenge: null };

  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === configuredVerifyToken && challenge !== null) {
    return { ok: true, challenge };
  }
  return { ok: false, challenge: null };
}

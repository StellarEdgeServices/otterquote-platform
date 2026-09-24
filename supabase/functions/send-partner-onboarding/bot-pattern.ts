// gh-2154 P-4 — same three bot-account email patterns notify-admin-new-partner
// (P-3) and notify-admin-new-contractor match. Duplicated rather than
// imported: this repo's Edge Function deploy path does not resolve _shared/
// imports across function directories (see send-home-profile-prompt's
// emailButton comment, and send-homeowner-next-steps/index.ts's identical
// note on why its own convention constants aren't imported from a shared
// module either) — so every function that needs this owns its own copy,
// byte-identical to the others, verbatim.
export function isTestAccount(email: string): boolean {
  const lower = (email || "").toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

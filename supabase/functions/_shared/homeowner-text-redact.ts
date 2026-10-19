// [gh-2559 / D-390] Homeowner-typed text that reaches the SELECTED contractor before the Platform Fee is collected has its phone-shaped and
// e-mail-shaped text removed. For the bidder view, the thread view and the notification e-mail preview the patterns live in ONE place, the Postgres function
// public.d390_redact_contact (the bidder rule b/c patterns of ledger 20261008231303), so those three redact identically. The signed Scope of Work does NOT: it uses
// its own narrower in-process patterns (SOW_PATTERNS below; LEGAL-READ 6256737488 L4; precision over recall). This helper only decides WHEN
// (fee not collected) and fails CLOSED: if the function cannot be reached, the typed text is never passed on. What happens instead depends on the
// surface, and neither prints any wording of our own (LEGAL-READ 6256212786 L1):
//   - Scope of Work (a signed document): redactSowTextOrRefuse() (in-process, no rpc) throws RedactionUnavailableError; the caller refuses to build the envelope.
//   - e-mail preview: homeownerTextForContractor() returns REMOVED_TOKEN, the same token the success path produces.
//
// feeCollected must be `claims.platform_fee_charged === true` (the column is nullable: null and false both redact).

export const REMOVED_TOKEN = "[removed]";

export class RedactionUnavailableError extends Error {
  readonly code = "d390_redaction_unavailable";
  constructor(reason: string) {
    super(`d390_redact_contact unavailable: ${reason}`);
    this.name = "RedactionUnavailableError";
  }
}

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

// Core: returns the redacted text, or throws RedactionUnavailableError when the rpc errors, returns no string, or throws.
export async function redactContactOrRefuse(
  supabase: RpcClient,
  text: string | null | undefined,
  feeCollected: boolean,
): Promise<string | null> {
  if (text === null || text === undefined || text === "") return text ?? null;
  if (feeCollected === true) return text;
  let res: { data: unknown; error: { message?: string } | null };
  try {
    res = await supabase.rpc("d390_redact_contact", { p_text: String(text).slice(0, 2000) });
  } catch (e) {
    throw new RedactionUnavailableError(e instanceof Error ? e.message : String(e));
  }
  if (res.error || typeof res.data !== "string") {
    throw new RedactionUnavailableError(res.error?.message ?? "no data");
  }
  return res.data;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// SCOPE OF WORK PATH (LEGAL-READ 6256737488 L4): the signed Scope of Work gets its OWN, narrower redaction, run here (no rpc). The bidder-view
// function public.d390_redact_contact is left as it is (over-redaction is the safe side on a non-contract view); on a document both parties sign,
// a deleted date, dollar figure or sentence changes the contract, so this path removes ONLY phone numbers and e-mail addresses:
//   - phone: North American shapes only. Optional +1 / 1, then area code and exchange (each first digit 2-9) and a 4-digit line, written with
//     at most one separator character (space, dot, dash) between groups, or parentheses, or as 10 contiguous
//     digits (11 with a leading 1). KNOWN RESIDUAL: a bare "250-500-1000" or "250 500 1000" or a 10-digit number starting 2-9 is phone-shaped. Digit boundaries: it never bites into a longer
//     digit run (a 12-digit claim number), never into a dotted or comma figure (12500.00, 1,250.00), and there is no bare 7-digit rule.
//   - e-mail: local@domain.tld with no space around the at-sign, local(at)domain.tld, local @ domain.tld with space(s) around the at-sign (only when the domain starts with
//     a letter, has a dot and ends in a listed lower-case TLD), and the spelled-out forms with an explicit dot token ("jane at example dot com") or a listed TLD
//     ("jane at example.com"). Never across a sentence break ("Leak at chimney. Please ..."), never "Shingles @ 400 per square". Residuals and advisory leaks of
//     these rules (precision over recall) are named in the pre-flight, SOW section.
// Matching runs on a length-preserving folded copy (full-width and compatibility characters become their plain form for DETECTION only); the
// matched spans are then cut out of the ORIGINAL text, so every unmatched character prints exactly as typed (cafe accent, ft squared, one half).
// The text is never truncated. All patterns are linear: each token pattern starts only at a token boundary (lookbehind).
// ---------------------------------------------------------------------------------------------------------------------------------------------

// One UTF-16 unit in, one out, so indexes in the folded copy are indexes in the original.
export function foldForDetection(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch.length === 1) {
      const f = ch.normalize("NFKC");
      out += f.length === 1 ? f : ch;
    } else {
      out += ch; // astral code point: keep (2 units in, 2 units out)
    }
  }
  return out;
}

// Phone group gap: at most ONE separator character (a run of plain spaces counts as one). A dash, dot or hyphen with spaces around it ("250 - 500 - 1000")
// is two characters and is not a phone gap, so a figure list survives. "/", "_", the middle dot and the bullet are NOT separators (precision over
// recall on the signed SOW: "Limits 250/500/1000" is a figure list; "317/555-0142" is an accepted advisory leak).
// Zero-width and soft-hyphen characters are ignored around a gap.
const ZW = "[\\u00ad\\u200b-\\u200d\\u2060\\ufeff]*";
const GAP = `${ZW}(?:[ \\t\\u00a0]+|[.\\-\\u2010-\\u2015])?${ZW}`;
const ci = (w: string) => [...w].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join("");
const AT_W = ci("at");
const DOT_W = ci("dot");
const LOCAL = "(?<![A-Za-z0-9._%+\\-])[A-Za-z0-9._%+\\-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?";
const DOT_TOKEN = `(?:[ \\t]*[\\(\\[\\{<][ \\t]*${DOT_W}[ \\t]*[\\)\\]\\}>][ \\t]*|[ \\t]+${DOT_W}[ \\t]+)`;
const DOT_ANY = `(?:${DOT_TOKEN}|[ \\t]*\\.)`;
const TLD_END = "(?![A-Za-z0-9\\-])";
// Listed TLDs: NO word of English (no it, in, me, us, to, be, so ...): "Leak at front.in the valley" must print as typed. Lower case, or all
// upper case for the spelled forms; a capitalised "front.Back" is never a TLD. A multi-part domain (gmail.co.uk) is taken whole.
const TLD_LIST = ["com", "net", "org", "edu", "gov", "io", "dev", "ca", "uk", "co", "pro"];
const TLDS = `(?:${[...TLD_LIST, ...TLD_LIST.map((t) => t.toUpperCase())].join("|")})`;
const TLDS_LOWER = `(?:${TLD_LIST.join("|")})`;
// "Look at the dot com era": the word right before "dot" is an article or determiner, so it is prose, not a domain (any case). A proper-noun-shaped word
// domain ("CALL AT FRONT DOT COM") is a named residual and is still removed.
const DETERMINERS = ["the", "a", "an", "this", "that", "these", "those", "our", "your", "my", "his", "her", "its", "their", "some", "any"].map(ci).join("|");
const NOT_DETERMINER = `(?<!(?<![A-Za-z0-9\\-])(?:${DETERMINERS}))`;
const SPACED_DOT = `(?:${NOT_DETERMINER}${DOT_TOKEN}|[ \\t]*\\.)`; // the determiner exclusion applies to the spaced-@ form too ("Meet @ the dot com booth")

const SOW_PATTERNS: RegExp[] = [
  // phone: NANP, group gaps of at most one separator character
  new RegExp(
    `(?<!\\d)(?<!\\d[.,\\-])(?:\\+?1${GAP})?(?:\\(\\s*[2-9]\\d{2}\\s*\\)|[2-9]\\d{2})${GAP}[2-9]\\d{2}${GAP}\\d{4}(?!\\d)(?![.,]\\d)`,
    "g",
  ),
  // e-mail, no space around the at-sign: local@domain whose LAST label is letters only (2+)
  new RegExp(`${LOCAL}@${LABEL}(?:${DOT_ANY}${LABEL})*${DOT_ANY}[A-Za-z]{2,}${TLD_END}`, "g"),
  // e-mail, "(at)" in any case: domain whose last label is letters only (2+)
  new RegExp(
    `${LOCAL}[ \\t]*[\\(\\[\\{<][ \\t]*${AT_W}[ \\t]*[\\)\\]\\}>][ \\t]*${LABEL}(?:${DOT_ANY}${LABEL})*${DOT_ANY}[A-Za-z]{2,}${TLD_END}`,
    "g",
  ),
  // e-mail, whitespace on either side of "@": only when the domain starts with a letter, has a dot and ends in a LISTED lower-case TLD
  new RegExp(
    `${LOCAL}(?:[ \\t]+@[ \\t]*|[ \\t]*@[ \\t]+)[A-Za-z](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?(?:${SPACED_DOT}${LABEL})*${SPACED_DOT}${TLDS_LOWER}${TLD_END}`,
    "g",
  ),
  // e-mail: "local at domain dot tld" (explicit dot token, listed TLD)
  new RegExp(`${LOCAL}[ \\t]+${AT_W}[ \\t]+(?:${LABEL}\\.)*${LABEL}${NOT_DETERMINER}${DOT_TOKEN}(?:${LABEL}${DOT_ANY})*${TLDS}${TLD_END}`, "g"),
  // e-mail: "local at domain.tld" with a listed TLD (multi-label such as gmail.co.uk is taken whole)
  new RegExp(`${LOCAL}[ \\t]+${AT_W}[ \\t]+(?:${LABEL}\\.)+${TLDS}${TLD_END}`, "g"),
];

// Returns the text with phone and e-mail spans replaced by REMOVED_TOKEN and everything else byte-for-byte as typed.
export function redactSowText(text: string): string {
  const folded = foldForDetection(text);
  if (folded.length !== text.length) throw new Error("fold changed the text length");
  const spans: Array<[number, number]> = [];
  for (const re of SOW_PATTERNS) {
    re.lastIndex = 0;
    for (const m of folded.matchAll(re)) {
      if (m[0].length > 0) spans.push([m.index!, m.index! + m[0].length]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let pos = 0;
  let curStart = spans[0][0];
  let curEnd = spans[0][1];
  const flush = () => {
    out += text.slice(pos, curStart) + REMOVED_TOKEN;
    pos = curEnd;
  };
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] <= curEnd) curEnd = Math.max(curEnd, spans[i][1]);
    else {
      flush();
      curStart = spans[i][0];
      curEnd = spans[i][1];
    }
  }
  flush();
  return out + text.slice(pos);
}

// SOW entry point. Same refusal contract as before: anything that stops the redaction (a non-text value, an engine error, a non-string result)
// throws RedactionUnavailableError and the caller refuses to build the envelope (503 d390_redaction_unavailable). The `engine` argument exists
// so a test can prove that refusal; production callers never pass it.
export function redactSowTextOrRefuse(
  text: string | null | undefined,
  feeCollected: boolean,
  engine: (t: string) => string = redactSowText,
): string | null {
  if (text === null || text === undefined || text === "") return text ?? null;
  if (feeCollected === true) return text;
  if (typeof text !== "string") throw new RedactionUnavailableError("value is not text");
  let out: unknown;
  try {
    out = engine(text);
  } catch (e) {
    throw new RedactionUnavailableError(e instanceof Error ? e.message : String(e));
  }
  if (typeof out !== "string") throw new RedactionUnavailableError("no text returned");
  return out;
}

// E-mail preview variant: on failure, log the reason and use the success-path token. No fee reference, no other wording.
export async function homeownerTextForContractor(
  supabase: RpcClient,
  text: string | null | undefined,
  feeCollected: boolean,
): Promise<string | null> {
  try {
    return await redactContactOrRefuse(supabase, text, feeCollected);
  } catch (e) {
    console.error("gh-2559 D-390: redaction failed; preview text replaced with the removed token", e instanceof Error ? e.message : String(e));
    return REMOVED_TOKEN;
  }
}

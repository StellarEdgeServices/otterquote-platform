
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
//   - e-mail: local@domain.tld with no space around the at-sign, local(at)domain.tld, local @ domain.tld with space(s) on either side of the at-sign (only when the domain starts with
//     a letter, has a dot and ends in a listed lower-case TLD), and the spelled-out forms with an explicit dot token ("jane at example dot com") or a listed TLD
//     ("jane at example.com"). Never across a sentence break ("Leak at chimney. Please ..."), never "Shingles @ 400 per square". Residuals and advisory leaks of
//     these rules (precision over recall) are named in the pre-flight, SOW section.
// [gh-3461] The output IS the string the document prints (see printForm below): the patterns run on it, and what they leave is what esc() prints, so the
// text redacted and the text printed cannot differ. Nothing is mapped back to the typed text. After the fee the typed text is returned untouched.
// The text is never truncated. All patterns are linear: each token pattern starts only at a token boundary (lookbehind).
// ---------------------------------------------------------------------------------------------------------------------------------------------

// One UTF-16 unit in, one out, so indexes in the folded copy are indexes in the original.
export function foldForDetection(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch.length === 1) {
      // [gh-2881 / review 6256286136 O1] NFKC does not map Arabic-Indic (U+0660-0669) or Extended Arabic-Indic (U+06F0-06F9) digits to ASCII,
      // so a phone number typed in them skipped every \d pattern below. Map them 1:1 (one unit in, one out) for DETECTION only.
      const cp = ch.charCodeAt(0);
      if (cp >= 0x0660 && cp <= 0x0669) { out += String.fromCharCode(48 + cp - 0x0660); continue; }
      if (cp >= 0x06f0 && cp <= 0x06f9) { out += String.fromCharCode(48 + cp - 0x06f0); continue; }
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

// [gh-3461 / D-390] The Scope of Work PDF prints each string through esc() in create-docusign-envelope/index.ts, which folds dashes, quotes, the ellipsis,
// the superscript two, the vulgar fractions and the no-break space to ASCII and then DROPS every other character outside space..tilde, so the words on
// either side of a dropped character print joined. Matching the typed text and mapping back kept either leaking a contact or deleting agreed words
// (reviews 6668694968 and 6668877014, legal reads 6668719622 and 6668877912). So before the fee this path produces the exact string that will print and
// redacts THAT, and esc() has nothing left to drop:
//   - a character with no visible width (zero-width, soft hyphen, joiner, BOM, combining mark) is removed;
//   - every other character esc() would drop (line break, tab, emoji, symbol, accented letter) becomes one space, so nothing joins;
//   - the characters esc() folds print as esc() folds them.
// One zero-width exception: after a full stop and before anything but a digit it counts as a space, or "Install at 400.<zero-width>Friday" would join the
// sentences into an address shape. printForm() also returns `marked`, the same length as `printed`, with the unit SOFT wherever a dropped or folded character
// landed. A few contact forms can only be seen by reading across those places ("jane@exam<break>ple.com"); only the second pass below does that, and it
// keeps what it finds only on the narrow terms in keepSplitEmail(), so a sentence ending in a price and a new line stays as typed.
const PRINT_FOLDS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "…": "...", "²": "2", "½": "1/2", "¼": "1/4", "¾": "3/4", " ": " ",
};
const printOf = (ch: string): string => {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x2010 && cp <= 0x2015 ? "-" : PRINT_FOLDS[ch] ?? (cp >= 0x20 && cp <= 0x7e ? ch : "");
};
const NO_WIDTH = /^[\p{Cf}\p{Mn}\p{Me}]$/u;
const QUOTES_AND_ELLIPSIS = /^[‘-‟…]$/;
const SOFT = "\x1f"; // typed control characters can never reach `marked`: they are dropped characters themselves
const FOLDED_DASH = "\x1e";
// Pinned by sow-redact.test.ts (LEGAL-READ 6256737488 L4), with Ben as a ruling (Q 6668703638 on #3461): exactly the shapes "317<middle dot>555<middle dot>0142",
// "250 <bullet> 500 <bullet> 1000" and "250 <middle dot> 500 <middle dot> 1000", the same character twice with even spacing, and not with a leading 1 or a
// further group. These two characters stay in the output as typed, so THIS IS THE ONE PLACE esc() STILL DROPS SOMETHING: the unspaced form prints as ten digits
// until the ruling comes. Everywhere else they are dropped characters like any other.
const PINNED_FIGURES =
  /(?<!\d)(?<!(?<!\d)\+?1[\s.\-·•]*)(?:\d{3}·\d{3}·\d{4}|\d{3} ([·•]) \d{3} \1 \d{4})(?!\d)(?![.,]\d)(?! ?[·•] ?\d)/g;

export function printForm(text: string): { printed: string; marked: string } {
  const folded = foldForDetection(text);
  const pinned = new Set<number>();
  for (const m of folded.matchAll(PINNED_FIGURES)) {
    for (let k = m.index!; k < m.index! + m[0].length; k++) if (folded[k] === "·" || folded[k] === "•") pinned.add(k);
  }
  let printed = "";
  let marked = "";
  let afterDropped = false;
  const dropped = () => {
    afterDropped = true;
    if (printed !== "" && !printed.endsWith(" ")) { printed += " "; marked += SOFT; }
  };
  let i = 0;
  for (const ch of folded) {
    const at = i;
    i += ch.length;
    if (pinned.has(at)) { printed += ch; marked += ch; continue; }
    const out = printOf(ch);
    if (out === "" || (out === " " && text[at] !== " ")) { // the folded copy has already made wide and no-break spaces plain; they count as dropped
      if (!NO_WIDTH.test(ch) || (printed.endsWith(".") && i < folded.length && !/\d/.test(folded[i]))) dropped();
      continue;
    }
    if (out === " " && afterDropped && printed.endsWith(" ")) continue;
    afterDropped = false;
    printed += out;
    marked += out === "-" && ch !== "-" ? FOLDED_DASH : QUOTES_AND_ELLIPSIS.test(ch) ? SOFT.repeat(out.length) : out;
  }
  if (printed.endsWith(" ") && marked.endsWith(SOFT)) { printed = printed.slice(0, -1); marked = marked.slice(0, -1); }
  // One folded dash prints and reads as a dash ("100-250", "11-15-2026"); doubled it is no separator anyone types by hand.
  marked = marked.replace(/[-\x1e]*\x1e[-\x1e]*/g, (d) => (d.length > 1 ? SOFT.repeat(d.length) : "-"));
  return { printed, marked };
}

// ---- the second pass, on `marked` only; every match must cross a SOFT unit, because the patterns above already read the same text without one ----
const S = "\\x1f";
const WS = `[ ${S}]`;
const gapped = (w: string) => [...w].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join(`${S}*`);
const SPLIT_GAP = `(?:[ ]+|[.\\-${S}]*)`;
const SPLIT_D = `\\d${S}*`;
const SPLIT_GROUP3 = `[2-9]${S}*\\d${S}*\\d`;
const SPLIT_PHONE = new RegExp(
  `(?<!\\d)(?<!\\d[.,\\-])(?:\\+?1${SPLIT_GAP})?(?:\\(${WS}*${SPLIT_GROUP3}${WS}*\\)|${SPLIT_GROUP3})${SPLIT_GAP}${SPLIT_GROUP3}${SPLIT_GAP}${SPLIT_D}${SPLIT_D}${SPLIT_D}\\d(?!\\d)(?![.,]\\d)`,
  "g",
);
const SPLIT_AT = `(?:${WS}*@${WS}*|${WS}*[\\(\\[\\{<]${WS}*${gapped("at")}${WS}*[\\)\\]\\}>]${WS}*|${WS}+${gapped("at")}${WS}+)`;
const SPLIT_DOT = `(?:${NOT_DETERMINER}(?:${WS}*[\\(\\[\\{<]${WS}*${gapped("dot")}${WS}*[\\)\\]\\}>]${WS}*|${WS}+${gapped("dot")}${WS}+)|${WS}*\\.${S}*)`;
const SPLIT_LABEL = `[A-Za-z0-9](?:[A-Za-z0-9\\-${S}]*[A-Za-z0-9])?`;
const SPLIT_TLD = [...TLD_LIST].sort((a, b) => b.length - a.length).map(gapped).join("|");
const SPLIT_EMAIL = new RegExp(`${LOCAL}${SPLIT_AT}${SPLIT_LABEL}(?:${SPLIT_DOT}${SPLIT_LABEL})*(${SPLIT_DOT}|${S}+)(${SPLIT_TLD})${TLD_END}`, "g");
// A dropped character right beside the at-sign of an otherwise whole address: any lower-case last label ("jane<emoji>@proton.me").
const BESIDE_AT = new RegExp(`${LOCAL}${S}*@${S}*[A-Za-z](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?(?:\\.${LABEL})*\\.[a-z]{2,}${TLD_END}`, "g");
// "Tax 250.<break>300.<break>1000 total" prints "250. 300. 1000", which is two characters between the groups and no phone gap, typed or not.
const SENTENCE_FIGURES = new RegExp(`^\\d{3}\\.${S}\\d{3}\\.${S}\\d{4}$`);
// Listed TLDs that are also words people start a line with ("Paid at closing.<break>net 30", "Leak at front.<break>co op").
const WORD_TLDS = /^(?:net|org|dev|ca|uk|co|pro)$/;
// "Look at t<break>he dot com era": the determiner rule above, with the break taken out.
const DETERMINER_THEN_DOT = new RegExp(`(?<![A-Za-z0-9\\-])(?:${DETERMINERS})[ ]*[\\(\\[\\{<]?[ ]*${DOT_W}`);
function keepSplitEmail(m: RegExpMatchArray): boolean {
  const all = m[0];
  if (!all.includes(SOFT) || DETERMINER_THEN_DOT.test(all.replaceAll(SOFT, ""))) return false;
  const tld = m[2].replaceAll(SOFT, "");
  const tight = all.includes("@") && !all.includes(" ");
  if (tld !== tld.toLowerCase() && (tld !== tld.toUpperCase() || /[a-z]/.test(all) || !/[@(\[{<]/.test(all))) return false;
  const word = WORD_TLDS.test(tld.toLowerCase());
  const noDot = !/[.dD]/.test(m[1]);
  if (noDot && (!tight || word)) return false;
  if (word && m[1].endsWith(SOFT) && !(tight && new RegExp(`@${S}*[A-Za-z]`).test(all))) return false;
  return true;
}

// Returns the string the document prints, with phone and e-mail spans replaced by REMOVED_TOKEN.
export function redactSowText(text: string): string {
  const { printed, marked } = printForm(text);
  if (printed.length !== marked.length) throw new Error("print form out of step");
  const spans: Array<[number, number]> = [];
  for (const re of SOW_PATTERNS) {
    for (const m of printed.matchAll(re)) if (m[0].length > 0) spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of marked.matchAll(SPLIT_PHONE)) {
    if (m[0].includes(SOFT) && !SENTENCE_FIGURES.test(m[0])) spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of marked.matchAll(BESIDE_AT)) if (m[0].includes(SOFT)) spans.push([m.index!, m.index! + m[0].length]);
  for (const m of marked.matchAll(SPLIT_EMAIL)) if (keepSplitEmail(m)) spans.push([m.index!, m.index! + m[0].length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let pos = 0;
  for (const [a, b] of spans) {
    if (a < pos) { pos = Math.max(pos, b); continue; }
    out += printed.slice(pos, a) + REMOVED_TOKEN;
    pos = b;
  }
  out += printed.slice(pos);
  // Printed equals redacted: anything esc() would still drop, other than the pinned characters, refuses the envelope rather than prints.
  if (/[^ -~·•]/.test(out)) throw new Error("output is not the printed form");
  return out;
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

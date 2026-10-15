// Test helper (gh-2794): structural tests must match CODE, never a comment that
// happens to mention the same identifier. A `//` that follows `:`, a quote or a
// backtick is part of a URL/string and is left alone.
//
// Why this exists: gh-2794 review item 3. The two older structural tests matched
// `maySubmitFinalEvidence\(\{` against raw source, and a new explanatory comment
// containing the same words satisfied them after the real call was deleted. Run
// any structural regex over stripComments(src) so only executable code can match.
// Known limit: a `//` inside a regex literal or after a closing quote is treated
// as a comment start; none of the files under test do that.
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

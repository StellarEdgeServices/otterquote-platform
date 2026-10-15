// Test helper (gh-2794): structural tests must match CODE, never a comment that
// happens to mention the same identifier. A `//` that follows `:`, a quote or a
// backtick is part of a URL/string and is left alone.
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

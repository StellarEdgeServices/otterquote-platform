## Summary

<!-- What changed and why, in a sentence or two. -->

## Issue linkage — read before choosing a keyword

If this PR does **not** close every acceptance criterion on an issue it touches, reference it with
`Refs #<n>` (or `Part of #<n>`) — **never** `Closes #<n>`, `Fixes #<n>`, or `Resolves #<n>`. A closing
keyword auto-closes the issue on merge with no human review, and a partial fix reported as "done" is
how a multi-half issue silently ships half-fixed (gh-969, closed twice in one day by exactly this).

Closing a multi-half issue is a separate, deliberate act taken after the *last* half lands, with a
comment stating what is covered and what is not.

- [ ] This PR closes **every** acceptance criterion on every issue it references below, **or** it uses
      `Refs #<n>` / `Part of #<n>` instead of a closing keyword for any issue it does not fully close.

**Issues referenced:** <!-- e.g. "Refs #123" or "Closes #123" -->

## Testing

<!-- How you verified this, or why verification doesn't apply. -->

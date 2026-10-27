# ADR-013 — Async-loaded state must be guarded before use, and page-init loads must be isolated

**Status:** Accepted
**Date:** 2026-07-07
**Context bugs:** #467 (contractor-settings payment setup: `Cannot read properties of null (reading 'id')`), #469 (contractor-profile Contract Templates stuck on "Loading templates…"). Same root class as the F-007 / ADR-011 async-lifecycle failures, applied to the classic (non-React) pages.

## Context

Two production bugs reported 2026-07-07 shared one root class: **code that touches async-loaded state without accounting for the not-yet-loaded / load-failed case.**

- **#467** — `contractor-settings.html`: `initializeStripeSetup()` dereferenced `contractorRecord.id` with no guard, while the three "Add Payment Method" buttons were clickable before `initSettings()` resolved the Supabase fetch that sets `contractorRecord`. Every *sibling* handler in the file guarded with `if (!contractorRecord || !sb) return;` — this one didn't. An early click threw a `TypeError`, which was caught and rendered to the contractor verbatim as `Setup error: Cannot read properties of null (reading 'id')`. On fetch failure the record stayed null with no visible signal.

- **#469** — `contractor-profile.html`: `loadContractTemplates()` / `loadPcTemplates()` ran *after* three earlier awaits (certifications, licenses, platform stats) inside one try block whose only `catch` did `console.error(...)`. Any earlier throw skipped the template loaders, leaving `#contractTemplatesGrid` / `#pcTemplatesGrid` on their "Loading templates…" placeholders permanently, with nothing shown to the user.

Both were silent to the user in the failure case (a raw JS string, or an eternal spinner) and both were invisible to backend monitoring.

## Decision

1. **Guard async-loaded state at the point of use.** Any DOM handler (`onclick`, etc.) or function that reads module-level async-loaded state (e.g. `contractorRecord`, `sb`) MUST guard at the top — `if (!state || !sb) { <friendly message>; return; }` — before any dereference, matching the sibling-handler convention already in the file. Never surface a raw caught error string (`'…' + err.message`) to the user for a predictable not-loaded race.

2. **Disable controls that depend on loaded state until it is loaded.** Interactive controls whose handlers require async-loaded state SHOULD ship `disabled` and be enabled only once the load is confirmed, so users can't act ahead of the fetch.

3. **Isolate independent page-init loads.** A page-init routine that performs multiple *independent* async loads MUST isolate each in its own `try/catch` (see the existing D-204 pattern in `contractor-profile.html`) so one failure cannot skip the others. A single outer `try/catch` that only `console.error`s is prohibited when it wraps multiple independent user-visible sections.

4. **Every "Loading…" placeholder must resolve.** Any element that shows a "Loading…" placeholder MUST have a code path that replaces it with content OR a visible error/retry state on failure — never leave a permanent placeholder.

## Verification requirement

Exercise the *failure* path, not just the happy path: throttle the network so controls are clickable before the fetch resolves (#467), or force an early awaited load to throw (#469). Confirm (a) no raw JS error reaches the UI, and (b) no permanent "Loading…" placeholder remains — a visible retry/error state or rendered empty state appears instead.

## Consequences

- Eliminates the raw-error-string and eternal-spinner failure modes on the classic contractor pages.
- Added as a HIGH item ("Async State Guards") in `Deploy_Review_Checklist.md`.
- Applies to classic (`js/auth.js`-style) pages; the React equivalent is ADR-011. New authenticated classic pages that read async state should be audited against this ADR.

# ADR-010: Schema Column Lint CI Check

**Status:** Accepted  
**Date:** 2026-05-13  
**Author:** Wingman F-22 (Task 86e1ceeab)  
**Implements:** D-210 (schema contract enforcement)

---

## Context

Two silent production bugs in OtterQuote history were caused by writing to
Supabase column names that did not exist in the public schema:

1. `coi_document_url` written instead of `coi_file_url` on `contractors`
   (D-210, May 13 2026) — the insert silently ignored the unknown column.
2. `wc_exemption_claimed` written as a phantom column (D-210, fixed commit 23488d0).

Both went undetected by TypeScript and ESLint because the Supabase JS client
accepts arbitrary object shapes at the JS layer. The errors only surfaced at
runtime when the expected data was absent.

## Decision

Add `scripts/schema-column-lint.py` as a CI gate that statically validates
every `.from('table').insert/update/upsert({...})` call site against a
committed schema snapshot (`sql/schema-snapshot.json`).

The linter runs on every push to `staging`/`main` and every PR to `main`
via `.github/workflows/schema-lint.yml`.

## Scope

- **Scanned:** `.html`, `.js`, `.ts`, `.tsx`, `.jsx` under the repo root,
  excluding `node_modules`, `tests`, `e2e`, `.github`.
- **Write operations validated:** `insert`, `update`, `upsert`.
- **Read operations skipped:** `select` is not validated (column names there
  are legitimately dynamic).

## Key Design Choices

### Depth-0 extraction only (no JSONB nesting)

The extractor tracks brace depth and emits keys **only at depth==1** (directly
inside the object passed to the write call). Nested JSONB sub-objects such as:

```js
.insert({ event_type: 'x', metadata: { claim_id: y } })
```

...do not produce violations for `claim_id` because it is inside a nested
brace. Without this, the original naive regex produced 132 false-positive
violations against `activity_log` inserts whose `metadata` column stores
arbitrary JSON.

### Shorthand property support

ES6 shorthand properties (`{ contractor_id, event_type: 'x' }`) are captured
correctly. The extractor detects an identifier at depth==1 followed by `,`,
`}`, or a newline/comment rather than `:`.

### Non-literal argument skipping

If the first argument to `.insert/update/upsert()` is a variable (not an
inline `{...}`), the call is emitted as a **WARN** rather than validated. This
prevents false positives from:

```js
.upsert(payloadObj, { onConflict: 'user_id' })
```

...where the options object would otherwise be mistaken for the data object.

### Dynamic object skipping

If the object contains a spread (`...`) or computed key (`[expr]`), a **WARN**
is emitted and the keys are not validated. Spread targets are not treated as
shorthand properties.

### `// rpc-arg` exemption

Any property annotated with `// rpc-arg` on the same line is skipped from
column validation. Use this for Supabase RPC calls that happen to use the
`.from().upsert()` pattern with non-schema argument names.

### Schema snapshot

`sql/schema-snapshot.json` stores `{ table_name: [col, col, ...] }` for all
52 public tables. It is regenerated manually whenever the schema changes:

```
python3 scripts/refresh-schema-snapshot.py   # (generates from Supabase MCP)
```

Or regenerated automatically as part of migration deploy via D-221 flow.

## Violation Backlog (as of 2026-05-13)

The initial run against the codebase found **58 genuine violations** across
these categories:

| Category | Count | Root cause |
|----------|------:|-----------|
| `activity_log` wrong column names | 13 | Code writes `contractor_id`, `claim_id`, `action`, `action_type`, `description` — schema only has `user_id`, `event_type`, `title`, `metadata` |
| `notifications` old schema names | 15 | Code uses `title`, `message`, `metadata` — schema uses `notification_type`, `channel`, `message_preview` |
| `referrals` phantom columns | 10 | `referral_code`, `event_type`, `user_agent`, `timestamp` don't exist |
| `leads` wrong column names | 6 | `full_name`→`name`, `phone`, `notes` don't exist |
| `claims` wrong column names | 4 | `submitted_at`→`bids_submitted_at`, `homeowner_id` |
| Other | 10 | Scattered individual column name mismatches |

The workflow runs in **warn-only mode for PRs to staging** while this backlog
is addressed, and **hard-fail for pushes to main**.

## Consequences

- New column name bugs are caught in CI before reaching staging.
- `difflib` suggestions in violation output accelerate manual fixes.
- 39 warnings (non-literal args, dynamic objects) remain uninspected — each
  represents a write call that cannot be statically validated.
- The schema snapshot must be kept current. Stale snapshots will cause
  false-positive violations for newly added columns.

## Alternatives Considered

- **TypeScript strict types via Supabase codegen** — requires migrating all
  HTML/plain-JS files to TypeScript. Out of scope for this task.
- **Runtime validation (Zod/Joi)** — adds runtime overhead and still misses
  the error before production.
- **ESLint plugin** — would require a custom plugin and eslint in CI. Python
  linter is simpler and matches the existing CI tooling pattern in `scripts/`.

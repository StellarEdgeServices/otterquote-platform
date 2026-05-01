# OtterQuote Deploy — Claude Working Rules

This file governs how Claude (and any AI assistant) interacts with the files in this directory.

---

## ⚠️ Large File Edit Rules — MANDATORY

The Cowork Edit tool **silently truncates files** when writing through the Windows bindfs mount. Files over ~1,500 lines will be corrupted without any error message.

### Files that MUST NOT be edited via the Cowork Edit tool directly:

| File | Reason |
|------|--------|
| `contractor-profile.html` | Large page — confirmed truncation risk |
| `contractor-bid-form.html` | Large page — confirmed truncation risk |
| `supabase/functions/create-docusign-envelope/index.ts` | Large Edge Function — confirmed truncation risk |
| `js/auth.js` | Large auth module — confirmed truncation risk |
| **Any file over ~1,500 lines** | General rule — check line count before editing |

### Required approach for these files:

Use Python or bash to apply patches. Read the file in memory, modify, write to `/tmp/`, then commit from there. Never pipe the file through the Cowork Edit tool or `cp` from the Windows mount.

**Also unsafe on any file via the Windows mount:**
- `sed -i` — uses a temp file + rename under the hood; truncates through bindfs (confirmed May 1, 2026 on a 112-line file)
- Any tool that writes by creating a temp file and renaming (patch, perl -i, etc.)

**Safe operations on the mount:** direct writes (`echo > file`, `cat > file`, `cp /tmp/file mount/file`), the Cowork Write/Edit tools for files under ~1,500 lines.

**Recovery command for Edge Functions if truncated:**
```bash
supabase functions download [function-name] --project-ref yeszghaspzwwstvsrioa
```
This restores the complete production source. Use for:
- `create-docusign-envelope`
- `create-hover-order`
- `get-hover-pdf`
- `process-coi-reminders`

---

## Deployment Rules

See `~/Downloads/Claude Downloads/Claude's Memories/claude-memory.md` for the full Base Deploy Steps and D-182 tier system. Key rules:

1. **Always check the site is up first:** `web_fetch https://otterquote.com` — confirm 200 + "Stop chasing contractors" in body before any deploy. (April 27, 2026: 9.5-hour outage caused by Netlify billing pause was not detected by backend monitoring.)
2. **Use a unique temp dir:** `DEPLOY_DIR=/tmp/deploy-$(date +%s)` — never hardcode `/tmp/deploy`.
3. **Run Deploy_Review_Checklist.md before every push.** CRITICAL items block always. HIGH items block absent explicit waiver.
4. **Deploy to staging first.** Verify smoke tests pass → merge to main → Netlify auto-deploys production.
5. **Clean up after deploy:** `pip cache purge && apt-get clean && rm -rf $DEPLOY_DIR`

---

## D-196 Drift Check

After rsync'ing from `otterquote-deploy/` to `$DEPLOY_DIR`, run:

```bash
cd $DEPLOY_DIR && git status --short
```

If any unexpected files appear (files not in the intended changeset), **halt and surface to Dustin before pushing.** This catches local-repo drift before it reaches production.

---

## Auth Pattern (F-007)

All authenticated pages must use the `onAuthStateChange` + `INITIAL_SESSION`/`SIGNED_IN` guard + `_initFired` boolean pattern. **Never** bootstrap with `DOMContentLoaded + sb.auth.getSession()` — this causes race conditions on Supabase JS v2.

```javascript
let _initFired = false;
sb.auth.onAuthStateChange((event, session) => {
  if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !_initFired) {
    _initFired = true;
    // init page here
  }
});
```

Apply to every new authenticated page. Pages already using this pattern: dashboard.html, admin-payouts.html, bids.html, contract-signing.html, contractor-bid-form.html, contractor-pre-approval.html.

---

## Config Scope Rule

`config.js` declares `var CONFIG` (not `const` or `let`) so that `window.CONFIG` works across classic `<script>` tags. `let sb` is declared at top level — accessible as bare `sb` across script blocks on the same page, but NOT as `window.sb`. Always use bare `sb`, never `window.sb`.

---

*Last updated: May 1, 2026 — Created as part of D-196 project-rules enforcement (86e164xye).*

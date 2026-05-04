# OtterQuote Deploy — Claude Working Rules

This file governs how Claude (and any AI assistant) interacts with the files in this directory.

---

## ⚠️ Large File Edit Rules — MANDATORY

The Cowork Edit tool **silently truncates files** when writing through the Windows bindfs mount. The truncation can hit files of *any size* — confirmed May 4, 2026 on a 161-line file (`auth-callback.html`) and a 587-line file (`get-started.html`) — so the prior "~1,500 lines" threshold is obsolete. **Treat the Cowork Edit and Write tools as unsafe for any file inside `otterquote-deploy/`.** Use Python with `shutil.copy2` for all writes to this directory.

### Files that MUST NOT be edited via the Cowork Edit tool directly:

| File | Reason |
|------|--------|
| `contractor-profile.html` | Large page — confirmed truncation risk |
| `contractor-bid-form.html` | Large page — confirmed truncation risk |
| `supabase/functions/create-docusign-envelope/index.ts` | Large Edge Function — confirmed truncation risk |
| `supabase/functions/create-hover-order/index.ts` | Large Edge Function — confirmed truncation risk |
| `supabase/functions/get-hover-pdf/index.ts` | Large Edge Function — confirmed truncation risk |
| `supabase/functions/process-coi-reminders/index.ts` | Large Edge Function — confirmed truncation risk |
| `js/auth.js` | Large auth module — confirmed truncation risk |
| **Any file in `otterquote-deploy/`** | Cowork Edit/Write through bindfs truncates silently at any size — confirmed May 4, 2026 on a 161-line file. Use Python `shutil.copy2` for all writes. |

### Required approach for these files:

Use Python or bash to apply patches. Read the file in memory, modify, write to `/tmp/`, then commit from there. Never pipe the file through the Cowork Edit tool or `cp` from the Windows mount.

**Also unsafe on any file via the Windows mount:**
- `sed -i` — uses a temp file + rename under the hood; truncates through bindfs (confirmed May 1, 2026 on a 112-line file)
- Any tool that writes by creating a temp file and renaming (patch, perl -i, etc.)

**Safe operations on the mount:** direct writes via Python `shutil.copy2` (preferred), or `cp /tmp/file mount/file` from a sandbox temp file. Avoid the Cowork Write/Edit tools entirely on this directory.

**Recovery command for Edge Functions if truncated:**
```bash
supabase functions download [function-name] --project-ref yeszghaspzwwstvsrioa
```
This restores the complete production source. Use for:
- `create-docusign-envelope`
- `create-hover-order`
- `get-hover-pdf`
- `process-coi-reminders`

For **committed non-Edge-Function source** (HTML, JS) truncated through the mount, restore via git:
```bash
git checkout HEAD -- <file-path>
```

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

Apply to every new authenticated page. Pages already using this pattern: dashboard.html, admin-payouts.html, bids.html, contract-signing.html, contractor-b
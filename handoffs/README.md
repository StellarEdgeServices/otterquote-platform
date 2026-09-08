# Handoffs

Per-session handoff notes from Claude Code sessions on OtterQuote. Each meaningful Code session writes one file here before exiting — even on partial completion. Cowork's archive skill reads new handoffs at the next session and updates memory.

This `README.md` is the only file in `handoffs/` that is tracked by git. Everything else in the folder is gitignored — handoffs are local session notes, not repo artifacts.

---

## File convention

**Path:** `handoffs/YYYY-MM-DD-HH-MM-[session-type].md`

**Session types:** `wingman` | `forge` | `executor` | `bug-killer` | `migration` | `feature` | `bugfix` | `config` | `hardshell` | `manual`

---

## Template

Copy everything below the line into a new `YYYY-MM-DD-HH-MM-[session-type].md` file in this folder, then fill it in.

---

```markdown
# Handoff File — [Session Type]
# Filename convention: YYYY-MM-DD-HH-MM-[session-type].md
# Place in: [repo-root]/handoffs/
# This folder is gitignored except for README.md. Do NOT commit handoff files.

---

## Session Type
<!-- Wingman / Forge / Executor / Bug-Killer / Migration / Manual -->

## Date/Time
<!-- 2026-MM-DD HH:MM ET -->

## Session Model
<!-- Opus / Sonnet / Haiku -->

## Tasks Completed
<!-- List ClickUp task IDs and names -->
- [task-id] Task name — DONE
- [task-id] Task name — DONE

## Tasks Abandoned / Skipped
<!-- Why each was skipped or left incomplete -->
- [task-id] Task name — REASON

## Files Changed
<!-- Every file touched. Be specific. -->
- `path/to/file.js` — description of change
- `path/to/other.sql` — description of change

## Git Commits
<!-- Commit hashes or branch names if applicable -->

## Unresolved Items
<!-- Anything that came up that wasn't completed -->

## Blockers for Next Session
<!-- What the next session needs to know before starting -->

## Next Session Should
<!-- Specific instructions for the next Code or Cowork session -->

---
<!-- ARCHIVED: [date] — added by Cowork archive skill after processing -->
```

<!-- ceo37-guard-control: trivial change for closure-guard.yml negative-control PR (issue #1877), delete-safe -->

# OtterQuote — Claude Code Project Instructions
# Operation Hardshell | Project CLAUDE.md | Written 2026-05-18 | Ghost-cleanup pass 2026-07-05

> **⚠️ CONSOLIDATION SPRINT (2026-07-05 → ~2026-07-12):** Autonomous queue executors and nightly bats are PAUSED. Do not claim ClickUp queue tasks from scheduled/headless sessions during the sprint. Critical fixes (security, production incidents) proceed normally. A full CLAUDE.md v2 lands at sprint close.

---

## SESSION START PROTOCOL
Every Code session must do these three things before any other work:

1. Read the most recent file in `handoffs/` (sorted by date in filename). If no handoff exists, proceed normally.
2. Check ClickUp list 901711730553 for any open `[HARDSHELL]` tasks — report current phase if migration is active.
3. Confirm MCP tools are available: ClickUp, Supabase, GitHub, Gmail, Sentry.

Then state: "Session initialized. Last handoff: [date or 'none']. Ready."

---

## IDENTITY & TONE
- You are Claude, CTO and Operating Partner for OtterQuote.
- Operator: Dustin Stohler (CEO, JD, co-founder). Treat as peer on legal questions.
- Advisor identity: opinionated, direct, never guess, say "I don't know" when uncertain.
- Proper grammar always. His typos are haste.
- Tell Dustin when he is wrong.

---

## AUTHORITY MODEL (R-004)
| Tier | When | Action |
|------|------|--------|
| A — Autonomous | Pure implementation, no visible product change | Execute, no ask |
| B — Notify-After | Visible UX detail, no D-number impact | Ship, then tell Dustin |
| C — Ask First | D-number, money, legal, brand, Stripe, Tier 3B deploy | Ask before proceeding |

Pre-escalation check (R-015): Before surfacing ANY Tier C question, verify whether an existing rule or D-number already resolves it. If yes → Tier A.

---

## HANDOFF PROTOCOL (mandatory)
Every meaningful Code session writes a handoff file before exiting.

**Path:** `handoffs/YYYY-MM-DD-HH-MM-[session-type].md`
**Template sections:**
- Session Type
- Date/Time
- Tasks Completed (ClickUp IDs)
- Files Changed (list every file)
- Unresolved Items
- Next Session Should

Handoffs folder is gitignored. Write the file even on partial completion.

---

## MEMORY SYSTEM
Authoritative memory is file-based only. Location: `C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\`

Key files to read when needed:
- `claude-memory.md` — master index, identity, rules summary
- `otterquote-memory.md` — build status, credentials, infrastructure
- `otterquote-D-registry.md` — D-number master registry (+ § Next D-Number counter)
- `rule-reference.md` — R-number registry (+ § Next R-Number counter)
- `otterquote-ref-platform.md` — architecture, deploy, integrations
- `otterquote-ref-product.md` — product decisions, UX flows
- `otterquote-ref-legal.md` — legal decisions, DocuSign, compliance

Do NOT use native memory tools. Do NOT trust training data about OtterQuote.
Never assign D/R numbers from this file. Current counters live in otterquote-D-registry.md (§ Next D-Number) and rule-reference.md (§ Next R-Number); claude-memory.md is pointer-only.

---

## DEPLOY CHAIN (D-221 Path A)
`commit_via_api.py` → GitHub feature branch → PR → GitHub Actions CI → merge to main → Netlify auto-deploys

**No direct commits to main — ever.** (A June 13 revenue fix went direct-to-main with no PR; it worked, but it left no review trail and broke task-closure evidence. Don't repeat it.)

Tier system (D-182, amended D-261):
- Tier 1: Frontend changes — autonomous after checklist
- Tier 2: New features — exec check first
- Tier 3A: Additive SQL/EF (new nullable columns, new tables, indexes, new EFs with no external side effects) — autonomous
- Tier 3B: Destructive/irreversible (DROP/ALTER/RLS changes, EFs touching Stripe/email/SMS/webhooks, migration rollbacks) — approval task per D-220

Before any git push: check Netlify deploy state (R-012). If state == 'error' → halt.

Deploy PAT: name `otterquote-wingman-deploy` (classic) — expires August 11, 2026, rotate by August 3. **Token VALUES are never written in this file or any memory/SKILL file (R-089).** Values live in `.deploy-secrets` (local, gitignored) and Doppler only. Authoritative token registry: exec-cto-memory.md SP#9.

---

## CRITICAL R-NUMBERS (full text in rule-reference.md)
- R-001: File-based memory only. No native memory tools.
- R-003: Error-log skill invoked proactively on ANY unexpected behavior. No deferring.
- R-004: Tier A/B/C authority model (above).
- R-005: Real-time task closure. When Dustin says "done/close/kill" → execute ClickUp closure that turn.
- R-006: Claude's effort is not a cost. Default to production-grade.
- R-007: Bug-Killer protocol. Bugs route to bug-killer skill, not run-work.
- R-012: Pre-deploy Netlify state check.
- R-015: Pre-escalation check before any Tier C surface.
- R-016: Proactive surface rule. Surface risks/gaps in the same turn, unprompted.
- R-019: Cost discipline (pre-launch). Opus for strategic; Sonnet for builds; Haiku for scans.
- R-031: Off-peak scheduling. Automated work runs 3 PM–7 AM ET.
- R-036: Failing E2E test = real product bug until proven otherwise.
- R-037: Fresh first-flow probe required for launch-readiness PASS claims.
- R-062: Skill masters live at `Claude Downloads\Claude's Memories\Skills\[skill]\SKILL.md`. (Supersedes retired R-013 "Skills Output" location — do not read or write `Skills Output/` skill files.)
- R-089: GitHub credential discipline — token values never in memory/SKILL/CLAUDE files.
- R-093: All content reads/writes in the Claude Downloads tree use host file tools, never the bash mount.

---

## SYSTEM ARCHITECTURE (POST-HARDSHELL)
- **Claude Code (this system):** Execution — runs code, touches repo, executes git, validates deploys
- **Cowork:** Brain/memory — partner meetings, status reports, memory management, document creation, browser automation

When Code completes significant work → write handoff file → Cowork archive skill picks it up.
When you need to update memory files → write to Claude Downloads paths above.

---

## TASK EXECUTION — run-work (unified executor)

**RETIRED (2026-06-10, R-087/R-088; kill-list finalized 2026-07-05):** the `/executor` and `/wingman` slash commands and their skill families (wingman, wingman-f18, wingman-code, wingman-f18-code, executor, executor-code, cowork-drain, cowork-drain-f18, cowork-lane2-light, cowork-lane2-light-f18). Do NOT invoke these names or read their SKILL.md files, even if copies still exist on disk. Any bat file, task, or document referencing them is stale — flag it via error-log.

**Current executor:** `run-work` — read `C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\Skills\run-work\SKILL.md` and follow it exactly. Three parameters: environment (cowork|code), model (haiku|sonnet|opus — DEFAULT HAIKU per R-088), mode (single|fanout|lane2light). Budget: single = 9 tasks/60 min/2 failures; fanout = 12 tasks/60 min/2 bad waves.

⚠️ Paused during the 2026-07-05 consolidation sprint (see banner).

---

### /bug-killer [task_id] [description]

Sequential, evidence-first bug investigation protocol. Routes the bug through the Stage 0–5 protocol — Stage 0 stop bleeding, Stage 1 read evidence (read-only sub-agent), Stage 2 hypothesis (autonomous for frontend+high-confidence; checkpoint for auth/payment/schema), Stage 3 minimal fix, Stage 4 verify+merge, Stage 5 prevention layer. Codified as R-007.

When invoked, reads and follows `C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\Skills\bug-killer-code\SKILL.md` exactly.

Pass the ClickUp task ID and a short description as the bug identifier:
- `/bug-killer 86e1XXXXX [short bug name]` — opens or resumes the bug thread at `Bug Threads/[task_id]-[name].md`

Orchestrator: Opus. Sub-agents: Sonnet (read-only Stage 1; bounded Stage 3). No parallel sub-agents — bug-killer is sequential. Two failed attempts = mandatory Dustin checkpoint. Prevention artifact in Stage 5 is non-negotiable.

---

### /migration-author [description]

Supabase SQL migration author. Drafts forward + rollback halves, runs against a Supabase branch before proposing, checks all 8 danger patterns, outputs `v<NN>_<slug>.sql` + `v<NN>_<slug>_rollback.sql` + `v<NN>_<slug>_pre-flight.md` to `supabase/migrations/`.

When invoked, reads and follows `C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\Skills\migration-author-code\SKILL.md` exactly.

All destructive migrations are **D-182 Tier 3B** — no migration self-deploys. After files are written and branch test passes, the skill creates a ClickUp approval task per D-220. Deploy chain is D-221 Path A: GitHub PR → merge → Supabase migration auto-run.

---

## CLICKUP
List 901711730553 = Product and Tech (primary work queue)
Close tasks with status: `complete`
Tier/Model custom fields must be populated for executor routing.
Board split migration in progress (2026-07-05 sprint) — engineering backlog moves to GitHub Issues at cutover; ClickUp becomes the CEO-facing board. Until cutover is announced in a handoff, ClickUp remains the queue.

---

## PROACTIVE RULES
- Surface any risk, gap, or better path in the same turn — never defer (R-016)
- Verify capabilities before declaring inability (R-017)
- Log errors immediately via structured comment or handoff note (R-003)
- One observation ≠ system overhaul — propose targeted delta only (R-026)

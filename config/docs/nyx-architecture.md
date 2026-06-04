# Nyx — System Architecture

**Purpose:** Development operations agent and personal assistant for the operator. Runs on the operator's local machine. All interaction happens through Claude's Dispatch interface — the operator describes what he wants in natural language, Dispatch breaks it into discrete tasks, queues them, and Nyx's background script executes them autonomously.

---

## Core Flow

```
the operator (phone or desktop)
  │
  │  "Harden the auth layer on Lens, add rate limiting
  │   and session timeouts, then run a full security scan"
  │
  ▼
Claude Dispatch
  │  Analyzes the prompt. Breaks into discrete tasks.
  │  Determines type, model, gate, dependencies.
  │  Appends entries to ~/nyx/nyx.md:
  │
  │  - [ ] LENS-RATE-LIMIT — Add rate limiting to Supabase auth endpoints
  │        [type: code] [repo: lens-cx/site-dev] [gate: typecheck,tests]
  │        [model: sonnet] [priority: high]
  │  - [ ] LENS-SESSION-TIMEOUT — Implement session timeout policy
  │        [type: code] [repo: lens-cx/site-dev] [gate: typecheck,tests]
  │        [model: sonnet] [depends: LENS-RATE-LIMIT]
  │  - [ ] LENS-SECURITY-SCAN — Full codebase security scan
  │        [type: analysis] [repo: lens-cx/site-dev] [gate: none]
  │        [model: opus] [output: outputs/reports/]
  │        [depends: LENS-SESSION-TIMEOUT]
  │
  ▼
nyx.md (the queue)
  │  Sits on disk. Source of truth. Human-readable.
  │  Dispatch only WRITES to this file.
  │  The background script only READS from it.
  │
  ▼
Nyx Dispatcher (launchd, every 15 min)
  │  Reads nyx.md → finds first unchecked task
  │  with satisfied dependencies → spins up Claude
  │  in an isolated worktree → runs gates → commits
  │  or outputs → marks task [x] → notifies Slack
  │
  ▼
the operator gets a Slack DM
  "✅ LENS-RATE-LIMIT shipped. 14 min, 12 tests passed.
   Next: LENS-SESSION-TIMEOUT queued, picking up on next tick."
```

the operator's only interface is the Dispatch prompt. He never touches nyx.md, never runs scripts, never SSH's in. He describes intent, Dispatch decomposes it, Nyx executes it.

---

## Dispatch Decomposition Rules

When Dispatch receives a prompt, it:

1. **Identifies discrete deliverables.** Each one becomes a separate task. "Harden auth and scan for vulnerabilities" = two tasks minimum (the hardening work + the scan).
2. **Determines task type** for each deliverable:
   - `code` — writes/modifies source code in a repo
   - `content` — produces documents, decks, copy, marketing material
   - `analysis` — reads a codebase and produces findings, no mutations
   - `assistant` — personal task (calendar, reminders, email triage)
3. **Sets the gate** based on type: code gets `typecheck,tests`, everything else gets `none` unless explicitly needed.
4. **Picks the model** based on complexity: Haiku for simple/assistant, Sonnet for standard code, Opus for complex architecture or analysis.
5. **Establishes dependencies** when tasks must run in order.
6. **Sets priority** — `high` jumps the queue.
7. **Appends to nyx.md** in the unchecked task section.
8. **Confirms to the operator** what was queued: task IDs, estimated order, dependencies.

Dispatch does NOT execute tasks. It only writes to the queue file. Execution is Nyx's job.

### Dispatch Session Instructions (~/.nyx/CLAUDE.md)

Every Dispatch-spawned session inherits project-level instructions from `~/nyx/CLAUDE.md`. This file MUST exist before the first Dispatch invocation — it's the first file created during setup. Contents teach Dispatch how to decompose and format tasks:

```
You are Nyx's task decomposer. When the operator describes work:

1. Break it into discrete, independently-executable tasks.
2. Append each task to ~/nyx/nyx.md under "## Active Tasks" using this format:

   - [ ] TASK-ID — Description [type: code|content|analysis|assistant] [model: sonnet|opus|haiku] [gate: typecheck,tests|none] [repo: org/name] [output: path/] [depends: OTHER-TASK] [priority: high|normal|low]

3. Never execute tasks directly. Only write to the queue.
4. Confirm what was queued: task IDs, order, dependencies, estimated dispatch time.

Task ID format: UPPERCASE-HYPHENATED, descriptive, unique.
Default gate: code → typecheck,tests. Everything else → none.
Default model: Haiku for assistant, Sonnet for code, Opus for complex analysis.
Default priority: normal.
```

Without this file, Dispatch sessions won't know the queue format or file path, and the entire Dispatch-first flow breaks.

---

## Nyx Dispatcher

### Entry Point

launchd fires `scripts/nyx-dispatch.sh` every 15 minutes:

1. Acquire atomic lockfile (`/tmp/nyx-dispatch.lock` via mkdir)
2. Source `~/nyx/.env`
3. Run `node apps/dispatcher/dist/cli/run-once.js`
4. Release lockfile on exit

### run-once.ts Flow

1. **Acquire PID lockfile.** If held by a live process, exit 0.
2. **Preflight contention check.** Scan for concurrent Claude processes. If found, audit `task.skipped.concurrent_claude`, exit 0.
3. **Read nyx.md** with task-reader.ts. Parse metadata tags.
4. **Find first unchecked task** respecting priority order and dependency satisfaction (all `depends` tasks must be `[x]`).
5. **Check for in-flight** (existing worktree/branch for this task ID). If found, skip.
6. **Branch by task type:**
   - `code` (local, no `[repo:]` tag): create worktree within `~/nyx/`
   - `code` (external, has `[repo:]` tag): shallow clone to `/tmp/nyx-clone-<taskId>/`, create branch — worktrees are NOT used for external repos
   - `analysis`: shallow clone repo to `/tmp/nyx-clone-<taskId>/` (read-only, no mutations)
   - `content`: create output directory
   - `assistant`: create output directory
7. **Invoke Claude** with task prompt, specified model, working directory.
8. **Audit** `task.started`, then `task.claude.exited` with exit code.
9. **Run test-gate.ts** with gate flags from metadata:
   - `gate: none` → skip to step 10
   - `gate: typecheck,tests` → install → build workspace deps → typecheck → tests
   - Any stage failure: capture full failure log in audit, notify Slack, preserve worktree
   - All-pass with non-zero exit: treat as pass, log warning
10. **Finalize by type:**
    - `code` (local): write sentinel, commit, merge to main, rebuild, restart services, poll health, remove sentinel. On failure: `git reset --hard HEAD~1`, rebuild, restart, audit `task.rollback`
    - `code` (external): push branch to origin, run `gh pr create --title "TASK-ID: description" --body "Generated by Nyx"`, capture PR URL, audit `task.pr.created`, notify Slack with PR link. No deploy, no health poll. If repo has CI, PR triggers it automatically. Auto-merge off by default.
    - `analysis`: move findings to output directory
    - `content`: move output to designated directory
    - `assistant`: post result to Slack DM
11. **Mark task `[x]`** in nyx.md using atomic write (write to `nyx.md.tmp`, rename over original).
12. **Audit** `task.completed` or `task.failed` — failure_log always included.
13. **Notify Slack DM** with outcome, duration, summary.
14. **If AUTO_CHAIN=true** and task succeeded and chain depth < `MAX_CHAIN_DEPTH`: immediately pick next task. Otherwise wait for next launchd tick.

### Retry Limit

The dispatcher tracks failure count per task ID via audit database query (count of `task.failed` events for this task ID). If count >= 3, the task is marked `[FAILED]` in nyx.md, audited as `task.abandoned` with the last failure log, and Slack-notified. The queue file stays clean — failure counts live in the audit DB, not in nyx.md.

### Atomic Queue Writes

Both Dispatch and the dispatcher use atomic writes: write to `nyx.md.tmp`, then `rename()` over `nyx.md`. Rename is atomic on all filesystems. If Dispatch appends while the dispatcher marks `[x]` simultaneously, worst case is a missed `[x]` that gets re-applied next tick. No data loss.

---

## Directory Structure

```
~/nyx/
  nyx.md              the task queue (Dispatch writes, dispatcher reads)
  .env                    runtime config, gitignored
  data/
    nyx.db            single audit database
  apps/
    dispatcher/           the dispatch engine
      src/
        cli/
          run-once.ts     entry point: preflight, lock, read queue, dispatch
          finalize.ts     post-gate merge/output, sentinel lifecycle
        task-reader.ts    parses nyx.md, extracts metadata tags
        task-runner.ts    invokes Claude against a task
        test-gate.ts      conditional pipeline based on [gate:] metadata
        git-ops.ts        worktree + branch management
        notifier.ts       Slack DM notifications
        audit.ts          hash-chained SQLite, failure_log always captured
        lockfile.ts       atomic PID-based lockfile
    assistant/            personal assistant features
      src/
        morning-brief.ts  daily briefing aggregator
        calendar-sync.ts  calendar awareness + scheduling
        reminder.ts       task reminders and follow-ups
        slack-digest.ts   Slack channel summarizer
        inbox-triage.ts   email/notification prioritization
    analyzer/             codebase analysis engine
      src/
        clone-and-scan.ts clone external repos to temp dir
        security-scan.ts  dependency audit, secret detection, CSP review
        arch-review.ts    architectural pattern analysis
        findings.ts       structured findings output
        pr-writer.ts      generates PRs from findings
  scripts/
    nyx-dispatch.sh   launchd entry point
  config/
    launchd/              plist files
  logs/                   per-run logs, retained 7 days
  outputs/                non-code task output (decks, reports, marketing)
  worktrees/              isolated git worktrees for code tasks
  context/                per-repo context files for cross-task memory
```

---

## Task Queue Format (nyx.md)

```markdown
# Nyx Task Queue

## Active Tasks

- [ ] LENS-RATE-LIMIT — Add rate limiting to Supabase auth endpoints
      [type: code] [repo: lens-cx/site-dev] [gate: typecheck,tests]
      [model: sonnet] [priority: high]
- [ ] LENS-SESSION-TIMEOUT — Implement session timeout policy
      [type: code] [repo: lens-cx/site-dev] [gate: typecheck,tests]
      [model: sonnet] [depends: LENS-RATE-LIMIT]
- [ ] MORNING-BRIEF — Aggregate Slack, email, calendar
      [type: assistant] [gate: none] [model: haiku] [recurring: daily 7:00]

## Completed

- [x] LENS-AUTH-HARDENING — Added rate limiting and session management
      [completed: 2026-05-19T02:14:00] [duration: 14m] [tests: 12 passed]
```

### Tag Reference

| Tag | Values | Purpose |
|-----|--------|---------|
| type | code, content, analysis, assistant | Determines execution path and gate defaults |
| repo | org/repo (e.g. lens-cx/site-dev) | Target repo for code and analysis tasks |
| gate | typecheck,tests / typecheck / tests / lint / none | Which pipeline stages to run |
| model | opus / sonnet / haiku | Claude model for this task |
| output | relative path (e.g. outputs/decks/) | Where non-code output lands |
| priority | high / normal / low | High jumps the queue |
| depends | TASK-ID | Won't dispatch until dependency is [x] |
| recurring | daily HH:MM / weekly DAY HH:MM | Re-added to queue on schedule |

### Recurring Task Re-queue

When the dispatcher completes a recurring task and marks it `[x]`, it immediately appends a fresh `[ ]` copy with identical metadata to the Active Tasks section. The completed copy stays in the Completed section as a historical record. No external cron or scheduler needed — the dispatcher handles re-queue inline after marking completion.

---

## Test Gate (Conditional Pipeline)

```
gate: typecheck,tests    →  install → build deps → typecheck → tests
gate: typecheck           →  install → build deps → typecheck
gate: tests               →  install → build deps → tests
gate: lint                →  install → build deps → lint
gate: none                →  skip everything, straight to output/commit
```

Each stage is wall-clock-bounded (5 min default). Failure log is always captured in the audit row. The "all tests passed but non-zero exit" pattern (vitest unhandled errors) is treated as pass with a logged warning.

The build-deps stage runs `pnpm --filter @package/shared build` (or broader) to ensure workspace packages that publish types via `dist/` are available before typecheck. Without this, fresh worktrees fail with TS2307 on every workspace dependency.

---

## Notifier (Slack DM)

Events that fire:

- **Task dispatched:** "Picking up LENS-RATE-LIMIT (code, sonnet, gate: typecheck+tests)"
- **Task completed:** "LENS-RATE-LIMIT shipped. 14 min, 12 tests passed. Merged to main."
- **Task failed:** "LENS-RATE-LIMIT failed at typecheck. Failure: [first 500 chars]. Worktree preserved."
- **Claude crashed:** "Claude exited code 1 on INVESTOR-DECK. Stderr: [contents or 'empty']."
- **Queue idle:** "All tasks checked. Queue idle." (once, not per tick)
- **Queue stale:** "No successful task in 24 hours." (once per day)

No uncooldown'd spam. Idle/stale alerts fire once then shut up until the condition changes.

---

## Audit System

Hash-chained SQLite. Single file `~/nyx/data/nyx.db`, single writer.

Table: `system_audit` (id, at, event, actor, payload, row_hash, prev_hash)

Critical design rule: `failure_log` is ALWAYS included in `task.failed` payloads. Never dropped, never truncated below 8KB.

Event taxonomy:
```
task.started, task.claude.exited, task.gate.completed
task.committed, task.merged, task.output.written
task.failed (with failure_log)
task.skipped.in_flight, task.skipped.depends_unmet, task.skipped.concurrent_claude
dispatch.tick, dispatch.idle, dispatch.stale
assistant.morning_brief, assistant.reminder, assistant.slack_digest
analyzer.clone.started, analyzer.scan.completed, analyzer.pr.created
```

---

## Analyzer

Clones external repos to a temp directory. Never writes to `~/nyx/`. No filesystem contention.

**security-scan.ts:** npm/pnpm audit, hardcoded secrets grep, committed .env detection, CSP header analysis, auth flow review, CORS check. Output: structured findings JSON with severity, file, line, recommendation.

**arch-review.ts:** dependency graph, circular imports, unused deps, test coverage gaps, dead code detection, naming convention consistency. Output: structured findings JSON.

**pr-writer.ts:** takes findings JSON, creates branch, applies auto-fixable issues, opens PR via `gh` CLI. PR URL logged to audit and Slack.

---

## Personal Assistant

Text-based, Slack-native. All assistant tasks run through the same dispatcher with `type: assistant`, `gate: none`, `model: haiku`.

**morning-brief.ts:** daily 7:00 AM. Aggregates today's calendar (Google Calendar MCP), unread Slack summary, pending nyx.md tasks, overnight task completions/failures. Posts structured message to Slack DM.

**calendar-sync.ts:** reads Google Calendar via MCP, flags conflicts and prep needed, feeds morning brief.

**reminder.ts:** recurring tasks in nyx.md. Posts to Slack DM when due.

**slack-digest.ts:** daily 6:30 AM. Summarizes overnight Slack activity across configured channels.

**inbox-triage.ts:** reads Gmail via MCP, categorizes urgent/needs-response/FYI/ignorable. Feeds morning brief. Can draft responses using Sonnet for review.

---

## Coordination & Safety

**Sentinel files:** finalize.ts writes `/tmp/nyx-finalize-in-progress.json` with `{pid, taskId, startedAt}` before pm2 restart. Any cleanup routine checks sentinel before acting. Deleted on exit via `process.on('exit')`. Stale sentinel (pid dead OR age > 10 min) is ignored.

**Lockfile:** PID-based at `/tmp/nyx-dispatch.lock`. Stale locks (dead PID) are cleaned automatically. Live locks cause clean exit 0 (not error).

**Preflight:** run-once.ts checks `ps` for concurrent Claude processes before starting. If found, audits skip, exits 0.

**Cooldowns:** all automated triggers (queue-stale alerts, idle notifications) have minimum 60-minute cooldowns. One fire per hour max.

**Chain depth limit:** `MAX_CHAIN_DEPTH` in .env (default 2). The dispatcher counts consecutive successful tasks in the current invocation. After hitting the limit, it stops and waits for the next launchd tick. Prevents runaway API usage from large queued batches. Audit: `dispatch.chain_limit_reached`.

---

## Env Template (.env)

```
# --- Claude Authentication ---
# OPTION A (default for validation): Leave ANTHROPIC_API_KEY unset.
# Claude Code uses your Max subscription. Usage counts against your
# interactive quota (shared across chat, Dispatch, Cowork, and Code).
# Set MAX_CHAIN_DEPTH low (1-2) to avoid burning your weekly allocation
# on overnight batch runs.
#
# OPTION B (recommended for production): Set ANTHROPIC_API_KEY to a
# separate API key from console.anthropic.com. Claude Code uses pay-as-you-go
# API billing instead of your subscription. Your Max quota stays untouched
# for interactive work. Typical cost: $0.50-2.00 per task (Sonnet),
# $2-5 per task (Opus). 10 tasks/day ≈ $5-20/day.
#
# WARNING: James burned hundreds of API credits on Jarvis by running a
# failing auto-builder 846 times in 4 days with no cooldown. Never run
# Nyx with AUTO_CHAIN=true and no MAX_CHAIN_DEPTH on an API key
# until the system is verified working.
ANTHROPIC_API_KEY=

SLACK_WEBHOOK_URL=
GITHUB_TOKEN=
AUTO_CHAIN=true
MAX_CHAIN_DEPTH=2
DISPATCH_INTERVAL_MINUTES=15
NYX_REPO_ROOT=~/nyx/
LOG_RETENTION_DAYS=7
```

---

## Future Additions

**GitHub webhook listener:** small server that receives PR review comments and CI failures, auto-generates task entries in nyx.md. Makes Nyx reactive, not just scheduled.

**Slack slash command:** `/nyx "description"` appends to queue with inferred metadata. Alternative to Dispatch for quick tasks.

**Cost tracking:** log API token usage per task. Weekly Slack summary of spend by task type, model, repo.

**Context persistence:** after each task, write brief summary to `context/<repo>.md`. Next task targeting that repo loads the context file into Claude's prompt. Cross-task memory without bloating the queue.

**Scheduled health checks:** weekly recurring clone + scan + delta report for all managed repos. Posted to Slack.

---

## Lessons from Jarvis (Baked In, Not Patched)

| Jarvis Failure | How It Happened | Nyx Prevention |
|---|---|---|
| Multiple writers racing | James opened Claude sessions against ~/jarvis/ while auto-builder ran | Single dispatcher, preflight contention check |
| Missing dist/ in worktrees | pnpm install skipped build step, typecheck failed on workspace deps | Build workspace deps as explicit pipeline stage |
| Dropped failure logs | build-runner.ts omitted failureLog from audit payload | failure_log always in audit, never dropped |
| Auto-fire credit burn | Watchdog fired every 10 min with no cooldown, 846 wasted runs | 60-min minimum cooldown on all automated triggers |
| Remediator killed finalize | Skip-loop nuked worktrees during pm2 restart | Sentinel file coordination |
| TTS leak killed test gate | Unrelated async error caused non-zero exit despite all tests passing | All-pass non-zero exit tolerance |
| Opaque failures | 0-byte stderr, no error context anywhere | Structured logging, Slack notifications, audit capture |
| Everything treated as code | Pitch decks ran through typecheck | Task metadata with conditional gates |
| No retry limit | Failed tasks retried infinitely every tick | 3-strike limit, mark [FAILED], notify, stop |
| No rollback | Failed deploys left broken code on main | git reset --hard HEAD~1 on finalize failure |
| Queue file race | Concurrent reads/writes could corrupt nyx.md | Atomic writes via tmp+rename |
| Unbounded chain | AUTO_CHAIN could run indefinitely burning quota | MAX_CHAIN_DEPTH cap (default 2) |
| Subscription credit burn | 846 failed auto-fires in 4 days on flat-rate plan | Cooldowns + chain limits + API key separation for production |

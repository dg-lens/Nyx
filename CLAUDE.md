# Nyx — Agent Session Instructions

> Auto-loaded for every Claude Code session pointed at a Nyx install. **Nyx is a drop-in autonomous agent-management framework:** it drains a scheduled task queue and spawns sandboxed `claude -p` subprocesses to do code, analysis, assistant, content, and pipeline work, recording every action on a hash-chained audit log.
>
> **Naming.** The display name is configurable via `NAME` in `.env` (read as `config.systemName`). This doc says "Nyx"; your install may be renamed.

---

## Mode detection

There are three modes. Figure out which you're in and follow only that section.

| If… | You are | Read |
|---|---|---|
| Someone is describing work in natural language ("what should Nyx do next") with no open source-editing context | **Dispatch** | the Dispatch section below |
| You've been opened to edit `apps/`, `scripts/`, `config/`, or framework docs, or handed a technical task | **Engineering** | the Engineering section below |
| You're a child process spawned by the dispatcher (`claude -p …`) | **Subtask** | Your prompt contains everything you need. Don't touch other files unless it tells you to. |

If unsure: assume Engineering.

> **Memory & knowledge subsystem (evolving).** The framework's durable knowledge lives in this doc plus per-app `CLAUDE.md` files. A graph-based memory subsystem (replacing flat tiered docs) is in development; until it lands, treat the per-app `CLAUDE.md` files as the authority for their module. Code paths that resolve legacy tiered references still work but are not the documented path.

---

## Framework invariants

Facts about how Nyx itself operates. They apply to any session touching this repo.

### Spawn compute & auth

Nyx spawns Claude Code subprocesses for every code/analysis/assistant task. They use `claude -p`'s native auth precedence — the spawn env passes through unmodified, so the install chooses by whether `ANTHROPIC_API_KEY` is present:

- **Local Max-plan OAuth:** leave `ANTHROPIC_API_KEY` unset in the spawn env (`.env` / launchd). `claude -p` falls back to the host's `~/.claude` OAuth — billing the host's Claude subscription, not pay-per-token API.
- **BYO API key:** set `ANTHROPIC_API_KEY` in `.env`. Subprocesses inherit it and bill per token.

There is no key-stripping — whatever is in the spawn env decides billing. To run on OAuth, keep `ANTHROPIC_API_KEY` out of `.env`/launchd/the ambient shell; a key that leaks into the env silently switches spawns to API billing.

### Spawn helper — process-group kill

All `claude -p` spawn sites go through `spawnWithTimeout` in `apps/dispatcher/src/spawn-helpers.ts`. **Do not add a raw `spawn()` for claude subprocesses** — use this helper.

Why: `claude` spawns tool-invocation grandchildren that inherit stdio pipe FDs. A plain `child.kill('SIGTERM')` exits claude but leaves grandchildren alive holding the pipe open, so the `close` event never fires — causing duration overshoots of up to 6×. The helper spawns `detached: true` (claude becomes a process-group leader) and kills via `process.kill(-pid, signal)`, signalling the whole group.

### Decomposer is blind to target repos

Dispatch-mode Claude has no Bash and no `gh` tools. It writes `[expects:]` paths and `[env:]` declarations from memory or pattern-matching, NOT from inspecting the target repo. Specs referencing paths the repo doesn't have pass decomposition cleanly and fail at the expects-verifier stage. When writing a task spec, verify paths against actual repo state first — read the target repo's `CLAUDE.md` for layout authority, or `gh repo view <owner>/<repo>` if available.

**`[expects:]` bracket-truncation with dynamic routes:** the `[expects:]` parser uses `]` as the close delimiter, so any path with a bracketed segment (`[slug]`, `[id]`, `[[...catchall]]`) is silently truncated at the first inner `]`. Workaround: declare the parent directory instead of the bracketed leaf path, or omit those files from `[expects:]` and rely on the gate. A brace-balanced parser is a pending fix.

### Gate lint gap

The local gate runs `pytest` + `pnpm test` but NOT `ruff` / `eslint` — lint failures only surface in CI after push. Code tasks touching Python tests should `uv run ruff check tests/` manually before exit, or CI bounces them after merge.

### Production deploy detection

After a code task pushes, the dispatcher compares the committed diff against `deployPatterns` configured in `config.gitTargets` for that repo. Any match emits **`task.production.deploy_required`** into the audit chain — observational only, does not block completion. Payload: `{ taskId, repo, matchedFiles, deployTargets }`, where `deployTargets` names the surfaces needing a manual deploy. `gitTargets` is empty by default; populate it per install for repos with sub-apps that need a manual deploy step. Implementation: `apps/dispatcher/src/deploy-detector.ts`, emitted from `apps/dispatcher/src/cli/finalize.ts`.

### Halt-check ordering invariant (dispatch loop)

In `apps/dispatcher/src/cli/run-once.ts` `main()`, `isTaskHalted(next.id)` **must** be called BEFORE `git.inFlight(next.id)`. Otherwise: when a task halts the process exits; on the next tick `inFlight` sees the working dir present but its sentinel PID dead, treats it as a crashed run, and wipes it (`stale_cleared`) — destroying the dir the operator needs to salvage the halt. Checking halt first `continue`s before `inFlight` runs, leaving the dir intact. Regression test: `apps/dispatcher/__tests__/halt-working-dir-preservation.test.ts`.

### Self-task caveats (tasks targeting the Nyx repo itself)

Code tasks with no `[repo:]` tag run in a `git worktree add` subdirectory of the Nyx repo. Two things to know:

- **Root typecheck must be `pnpm -r build`, not `pnpm -r typecheck`:** any workspace that imports another's compiled output (`@nyx/dispatcher/dist/<file>.js`) fails `tsc --noEmit` in a fresh worktree where `dist/` doesn't exist. `pnpm -r build` runs in topological order — builds `dispatcher/dist/` first, then dependents resolve.
- **Local-only repos have no `origin`:** `detectMainBranch()` falls back to `process.env['NYX_MAIN_BRANCH']` when `git symbolic-ref refs/remotes/origin/HEAD` fails. Set `NYX_MAIN_BRANCH=main` in `.env` for a local-only install, or the merge step throws.
- **A dirty working tree blocks merge:** `finalizeCodeLocal` runs `git merge` against the repo, which the operator may be editing. The audit-pass agent must `git stash push --include-untracked`, merge, then pop — never auto-commit the operator's pending edits.

### Task hang / closing-sentinel contract

All three task types share a hang pattern: the agent finishes its work then drifts (re-explores the tree, retries a slow MCP, sits in the chat loop) instead of exiting, so the only recourse is the wall-clock timeout (exit 124, masking real progress). Every task prompt template must require a terminal stdout line, after which the agent calls no further tools:

| Type | Required final line |
|---|---|
| `code` | `VERDICT: fixed — <summary>` |
| `analysis` | `ANALYSIS COMPLETE` |
| `assistant` | `ASSISTANT COMPLETE` |

**Audit-pass protocol on exit 124 + artifact present:** do NOT re-run from scratch. Inspect the preserved working dir. `code`: if declared artifacts exist and the diff looks complete, run the gate; pass → `VERDICT: fixed`; patch minor gaps in place. `analysis`: if the output file is non-empty and well-formed, spot-check 2–3 claims and exit. `assistant`: if the artifact is current, skip re-running and deliver directly.

### Audit-pass artifact contract

When the audit-pass agent finds no uncommitted changes but the required artifact exists on disk:

- **Content diverges from spec:** the artifact was scaffolded to a default that doesn't match this task's requirements. Read it, diff against the spec, patch the divergence, commit.
- **Target was never present (no-op):** a cleanup task ran against a file that never had the thing to remove. Grep for it; if zero matches, halt with an explicit "task is a no-op; mark complete manually" verdict. Do NOT fabricate cosmetic changes.

Invariant: when `no file changes` occurs and the artifact exists, diff artifact content against spec before exiting — never treat presence alone as completion.

### Composer layer (observation-only)

`apps/dispatcher/src/composer/` validates chain coherence for `[depends:]`-chained code tasks before execution. It is **observation-only — it never blocks execution.** A `type: code` task triggers 3 `claude -p` spawns: plan-only → composer-check → execute. Findings persist to a `composer_findings` table (queryable, not in the audit chain). Read `apps/dispatcher/src/composer/CLAUDE.md` before touching the spawn flow.

**Design intent (read before any stage promotion):** the composer is NOT meant to become a post-execution blocking gate on findings. Its intended role is a **pre-dispatch task-list compiler** — take candidate specs, normalize them into a canonical composed task list (exact symbols, verbatim schemas, anti-examples, acceptance criteria), reject what it can't normalize, then emit the composed specs to the executing agents (often parallel). Any stage promotion that turns it into a runtime gate without first making it the canonical pre-dispatch normalizer is the wrong shape.

### Doc-sweep verifier

After the gate passes, before `git.commitAll`, the finalizers run `apps/dispatcher/src/doc-sweep-verifier.ts`: it parses the task spec's `## Doc updates` section, extracts concrete file-path references, and compares them against the working tree's changed files. Any declared path that wasn't touched → `task.doc_sweep.failed` → audit pipeline. A spec with no `## Doc updates` section passes unconditionally. Fuzzy references with no concrete path fail preflight (`checkDocUpdatesSpecMalformed` in `preflight.ts`) before any compute is spent.

### Ambiguity escalation

A spawned code agent can surface an unresolvable aesthetic decision by writing `.nyx/ambiguity.json` in the working dir and **exiting 0** (exiting non-zero loses the structured path). The dispatcher detects it after `invokeClaude` returns 0 (before the gate), emits `task.ambiguity.escalated`, notifies the operator, and halts the task — blocking the chain until `nyx resume <TASK-ID>`. Schema (`apps/dispatcher/src/ambiguity-escalation.ts`):

```json
{
  "schema_version": 1,
  "task_id": "<id>",
  "question": "<one concrete question>",
  "options": [ { "label": "A", "description": "...", "pros": "...", "cons": "..." } ],
  "my_lean": "A",
  "lean_reason": "..."
}
```

Escalate only for genuine naming/structure ambiguity that compounds across the codebase (table names, module locations, new API shapes) — not self-contained implementation details or equivalent choices.

### Wisdom-capture

After a code task's main invocation exits 0 and the ambiguity check passes (before the gate), the dispatcher runs a restricted haiku spawn that reflects on what it learned and writes a routing decision. Lessons route to the relevant doc (the module `CLAUDE.md`, or a diagnostic-memory note in the evolving knowledge subsystem), or `None` when there's nothing durable. **Non-fatal by design:** a timeout, non-zero exit, or malformed file logs `task.wisdom.skipped` and continues to the gate — wisdom capture never blocks completion. Implementation: `apps/dispatcher/src/wisdom-capture.ts`.

### Pipeline orchestrator

`[type: pipeline]` turns one prompt into a reconciled, PR-ready feature via autonomous coding between **two human gates** (preview always; review only if unreconciled). It's an extension of the per-task dispatcher: `run-once.ts` redirects pipeline tasks into a stateful orchestrator; all other types run unchanged. Read `apps/dispatcher/src/pipeline/CLAUDE.md` before touching `apps/dispatcher/src/pipeline/`.

- **Flow:** planning → preview gate → parallel coders (git worktrees) → composer redux (merge clean) → shipping (smoke + recovery on held) → review gate (only if unresolved) → delivery (push integration branch, open a PR **without** auto-merge, fire `deploy_required`, brief) → done. Terminal: **PR-ready + gate-green; deploy is a manual step.** A clean run stops once (preview).
- **Queue a run:** `- [ ] PIPE-X — <prompt>` with `[type: pipeline] [repo: org/name]`. No `[repo:]` → plans against the Nyx repo.
- **Gate control (CLI):** `nyx pipeline list | status <RUN> | go <RUN> | revise <RUN> --note "…" | proceed <RUN> | fix <RUN> --note "…" | rollback <RUN> | abort <RUN>`. A decision arms the run; the next tick resumes it (`nyx tick` to apply now).
- **State** lives in `pipeline_runs` (mutable, self-contained so it resumes across ticks); the append-only record is the `pipeline.*` audit events.

---

# Mode: Dispatch

You are Nyx's task decomposer. Someone describes work in natural language; break it into discrete, independently-executable tasks and append them to the queue at the repo-root `nyx.md`.

## Rules

1. **Decompose.** Each discrete deliverable is its own task. "Harden auth and scan for vulnerabilities" is two tasks minimum.
2. **Append, never execute.** You only write to `nyx.md`. The dispatcher (a separate background process) is the only thing that executes. Never run code or start work — only queue.
3. **Atomic writes.** Write the full new contents to `nyx.md.tmp` and rename over the original. Never edit in place.
4. **Confirm.** After appending, reply with task IDs, where they go (slotted vs standing), and any dependencies.
5. **Doc-update responsibility.** When a `code` task's changes would affect future agent context (adds/renames env vars, new sub-apps, new deploy targets, new third-party services, auth/CORS contract changes), include a `## Doc updates` section naming the exact file(s) the agent must update. The doc-sweep verifier enforces concrete paths declared here. Skip the section for changes that don't affect future context (test-only, internal refactors).
6. **Migrations don't auto-apply.** SQL migrations in this framework do NOT auto-apply to production. Any `code` task that creates/alters DB schema MUST include either a copy-paste-ready idempotent SQL block under `## Apply to production`, or a `[depends:]` on the target repo's auto-apply task. Spawned agents have no prod DB access — closing this loop is the dispatch-author's job.

## Task format

```
- [ ] TASK-ID — Short description
      [type: code|content|analysis|assistant|pipeline]
      [model: sonnet|opus|haiku]
      [gate: typecheck,tests|typecheck|tests|lint|none]
      [slot: N]                       (optional — fires daily at slot N, 0–95)
      [every: 15m|30m|45m|Xh|Xd]      (optional — cadence anchored at slot 0)
      [repo: org/name]                (optional — code+repo, analysis, pipeline)
      [output: outputs/path/]         (optional — content, analysis)
      [depends: OTHER-TASK]           (optional)
      [priority: high|normal|low]     (optional, default normal)
      [bw-project: name]              (optional — see Bitwarden section)
      [env: NAME1, NAME2]             (optional — see Pre-flight)
      [expects: path1, path2]         (optional — see Expects)
      [reading: CLAUDE.md §Section, path/to/file.md]  (optional — see Reading-context)
```

A task has **at most one** of `[slot:]` or `[every:]`. Neither → standing list.

## Scheduling — slot grid

The day is 96 fifteen-minute slots. `slot = hour*4 + floor(min/15)` (e.g. 00:00→0, 06:00→24, 12:00→48, 18:00→72, 23:45→95).

- **`[slot: N]`** — fires daily at slot N. Stays Active forever; never marked `[x]`.
- **`[every: K]`** — anchored at slot 0; fires when `currentSlot % K === 0` (`every: 3h` ⇒ slots 0/12/24/…).
- **No scheduling tag** — standing list; pulled when a tick has no slotted task to fire.

## Read vs write permissions (spawned-Claude tool scoping)

| Type | Tools | Working directory |
|---|---|---|
| `assistant` | Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Write, Edit + configured MCPs — **no Bash** | empty `outputs/<TASK-ID>/` |
| `content` | same as assistant **but no MCPs** | `outputs/content/<TASK-ID>/` |
| `analysis` | above + Bash + MCPs | shallow clone in `/tmp/nyx-clone-<TASK-ID>/` |
| `code` | full default tool set | local worktree or PR-ready clone |

Anything that reads mail/calendar/chat = `assistant`. Anything modifying source = `code`. Read-only repo scan = `analysis`. Decks/copy = `content`.

## Defaults

| Tag | Default by type |
|---|---|
| gate | `code` → `typecheck,tests`; everything else → `none` |
| model | `assistant`→`haiku`, `code`→`sonnet`, `analysis`→`opus`, `content`→`sonnet` |
| priority | `normal` |

## Pre-flight

Before invoking Claude the dispatcher runs: (1) **install probe** — `pnpm install --prefer-offline` if `package.json`, `uv sync` if `pyproject.toml`; non-zero → fails at `preflight`. (2) **Env-var presence check** — only if the task declares `[env: …]`; resolves the Bitwarden project, verifies each name is present, halts with the exact `bws secret create` command if missing. Use `[env: …]` for vars referenced at runtime. Names only, never values.

## Audit + halt

On any failure (preflight, claude crash, gate, finalize, expects) the dispatcher invokes the **audit phase** immediately (no blind retry loop): a heuristic classifier maps known failure signatures to an auto-fix or operator report; unknown failures go to an Opus diagnostic agent that either finishes the work (`VERDICT: fixed`) or writes an operator report (`VERDICT: halt: …`). On a halt or after the audit cap (2 passes), Nyx emits `task.halted_for_review`, notifies the operator, and **blocks the chain** — downstream `[depends:]` tasks stay unpicked until `nyx resume <TASK-ID>`.

## `[expects:]` verifier

Gate-pass proves the code compiles and tests pass; it doesn't prove the task produced the artifacts the spec asked for. `[expects: migrations/0003_*.sql, src/admin/page.tsx]` declares files the task must produce — verified after the gate; missing → `task.expects.failed` → audit.

## `[reading:]` tag

Injects prior context — doc sections or files — into the spawned agent's prompt as a `## REQUIRED CONTEXT` block before the task header. Reference a section of this doc (`CLAUDE.md §Spawn helper`), a per-app doc (`apps/foo/CLAUDE.md §Routes`), or any file path. References are resolved at preflight; an unresolvable one fails preflight. Use for tasks that touch auth/CORS/schema, extend an existing pattern, or revisit a prior decision.

## Bitwarden Secrets Manager (optional)

Nyx can inject per-project secrets into spawns via `bws run --`. A task gets secrets either by an explicit `[bw-project: <name>]` tag, or implicitly when its `[repo:]` is registered to a Bitwarden project. Name the env vars in the description (e.g. *"use `process.env.SUPABASE_SERVICE_ROLE_KEY`"*) — spawned Claude doesn't auto-discover keys. Never put secret values in descriptions. MCP-backed integrations (mail/calendar/chat) need no Bitwarden. To add a secret to a project:

```bash
BWS_ACCESS_TOKEN=$(cat ~/.config/bitwarden/<project>.token) \
  bws secret create NEW_TOKEN 'value' <PROJECT-UUID>
```

## Examples

```
- [ ] MORNING-BRIEF — Daily mail/calendar/queue aggregator
      [type: assistant] [model: haiku] [gate: none] [slot: 24]

- [ ] RATE-LIMIT — Add rate limiting to the auth endpoints
      [type: code] [repo: org/api] [gate: typecheck,tests] [model: sonnet] [priority: high]

- [ ] DECK-Q3 — Draft slides for the Q3 update
      [type: content] [model: sonnet] [output: outputs/decks/]
```

## What you must not do (as Dispatch)

- No tool calls beyond reading/writing `nyx.md`.
- Don't spawn Claude, run `claude`, or shell out to do the work.
- Don't reorder/edit/delete existing tasks unless explicitly asked.
- Don't reuse a task ID that already appears — append a suffix.
- Don't combine `[slot:]` and `[every:]`.
- Don't put secret values in descriptions — names only.

---

# Mode: Engineering

You are working on Nyx's source code.

- **Workspaces:** `dispatcher` (engine), `assistant` (prompt templates), `analyzer` (scan library).
- **Local-only by design (v1.0):** the Supabase mirror, remote-action control, and web monitoring are a *deferred remote plugin* (not in this download). Nyx runs entirely on the local machine.
- **Hash-chained audit DB** — never modify past rows.
- **Slot-grid scheduling** (96 slots/day), not arbitrary timestamps.
- **Allowlist-with-MCP-discovery** permission model at spawn.
- **Bitwarden tokens never log.**
- **Tests** swap in `:memory:` SQLite via `_setAuditDb()` / `_setSecretsDb()` (and `_setPipelineDb()`, `_setNotificationsEnabled(false)` for pipeline/notifier). Never touch the real `nyx.db` in tests.

Operator commands:

```bash
# Source install
bash scripts/nyx-up.sh / down.sh / status.sh
bash scripts/nyx-tick.sh                  # force one dispatch
bash scripts/nyx-audit.sh --chain         # verify the hash chain
bash scripts/nyx-update.sh                # revert Core to stock origin/main + rebuild
pnpm -r build                             # all workspaces (topological)
pnpm --filter @nyx/dispatcher test

# Homebrew install (see config/Formula/nyx.rb)
brew tap dg-lens/nyx
brew install --HEAD dg-lens/nyx/nyx
brew services start dg-lens/nyx/nyx
brew reinstall --HEAD dg-lens/nyx/nyx     # update
```

**Core / Plugins / Data layout:** an install is three siblings under `~/Nyx` — `Core/` (this repo; `NYX_REPO_ROOT`), `Data/` (`NYX_DATA_DIR`: `.env`, `nyx.md`, `data/`, `logs/`, `outputs/`, `memory/`, `documents/`), and `Plugins/` (`NYX_PLUGINS_DIR`). `config.ts` resolves all personal paths from `NYX_DATA_DIR`, which is set by the launchd plist, the `nyx` wrapper, and `scripts/_layout.sh` (sibling auto-detection). If all three vars are unset (a flat clone), they collapse to the repo root — backward-compatible. `nyx update` hard-resets Core to stock `origin/main` without touching Data or Plugins.

Anything destructive (`launchctl unload`, `git reset`, schema drop): pause and confirm with the operator first.

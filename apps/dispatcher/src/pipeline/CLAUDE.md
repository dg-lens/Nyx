# Pipeline Orchestrator (Tier 3)

> Tier 3 doc for the pipeline module. [Tier 2: `~/Nyx/CLAUDE.md`] auto-loads
> alongside. The full design is [T5: `scaffold/prompt-to-product-pipeline.md`] —
> read it before any non-trivial change. This doc is the implementation map +
> the build-order status (what's real vs stub right now).

---

## What this is

One operator prompt (`[type: pipeline]` task) → a reconciled, gate-green,
PR-ready feature, with autonomous coding + composer self-reconciliation between
**two human gates** (preview always; review only-if-unreconciled). It is an
**extension of the per-task dispatcher**, not a new engine: each stage spawns
through the existing machinery (spawn-helpers, audit chain, git-ops worktrees,
secret injection). The new parts are a stateful orchestrator + the `pipeline_runs`
state table.

A pipeline run is **stateful across many ticks**. `advancePipeline` runs
autonomous segments back-to-back until a terminal status OR a gate with no
decision (a human pause), then returns — the run row holds the resume point.

---

## Build-order status (scaffold step N/6)

| Step | What | Status |
|---|---|---|
| 1 | `pipeline_runs` + state machine + tick redirect | ✅ shipped (v0.17) |
| 2 | Planning (decompose→flight-plans→align) + **preview gate** + CLI/portal decisions + 5-min tick | ✅ shipped (v0.18) |
| 3 | Executing: worktree parallel coder runner + concurrency cap | ✅ shipped (v0.19) |
| 4 | Composer redux (P1 facts+judge, P2 consolidation + merge queue) | ✅ shipped (v0.20) |
| 5 | Shipping: R1/R2 diagnostics + smoke/supervisor + **review gate** | ✅ shipped (v0.21) |
| 6 | Delivery (PR + brief) + base-clone cleanup | ✅ shipped (v0.22) |

**The build is complete (all 6 steps), now PHASED (v0.23).** Full flow: planning
→ ◧ preview gate → **executing as a sequence of PHASES** → shipping (final smoke)
→ ◨ review gate (only if unresolved/catastrophic) → delivery (PR, no auto-merge,
`deploy_required`, brief) → `done` + cleanup.

**Phased executing — the core model.** The decomposer splits work into phases
(`DagNode.phase`, 0-based). Phases run SEQUENTIALLY with a merge between, **one
phase per tick**: `stageExecuting` runs the current phase's coders off the LIVE
integration branch (which already carries phases 0..k-1's merged code — so a
later phase, e.g. tests, sees the earlier phases' REAL code), redux-merges the
phase, runs per-phase R1/R2 diagnostic recovery, then — clean + more phases →
advance `current_phase` and YIELD the tick; clean + last phase → shipping; still
held / catastrophic → review. Tasks WITHIN a phase are concurrent + isolated, so
`consumes` contracts are SAME-phase only; cross-phase deps are real merged code.
A phase must merge ALL its tasks clean (after R1/R2) to unlock the next.

Review verbs: `proceed` → deliver+done, `fix` → executing from phase 0 (fresh
corrective wave, threads the directive via `fix_directive`, resets counters),
`rollback` → planning, `abort` → cleanup+aborted.

Terminal A (v1): stops at PR-ready + gate-green — **deploy is the operator's
manual step** (autonomous deploy + CI-wait + auto-migrate are v2). For a no-repo
(self-target) run there's no origin to PR to: delivery emits a brief pointing at
the integration branch in the base clone and does not clean up.

---

## File map

| File | Role |
|---|---|
| `types.ts` | `PipelineRun`, `PipelineStatus` (9-state machine), `OperatorDecision`, terminal/awaiting predicates. |
| `state-machine.ts` | Pure legal-transition table. `assertTransition` throws on illegal moves (a stage bug surfaces loudly). `failed`/`aborted` are universal sinks. |
| `db.ts` | `pipeline_runs` table (idempotent, mutable, mirrors composer/db.ts posture) + `_setPipelineDb()`. CRUD + `activeRuns`/`runsAwaitingDecision`/`listRuns`. |
| `flight-plan.ts` | The pipeline's planning data: task DAG + flight-plan **interface contract** (`phase`/`creates`/`consumes`/`scope_boundary`), alignment, lenient parsers, the preview-brief renderer (renders phases), **`renderCoderSpec`** (compile a contract → the scoped coder prompt — each coder gets ONLY its slice, never the operator goal), **`groupPhases`** (bucket plans by `phase`, ascending), and **`detectScopeOverlaps`** (composer backstop — two tasks writing the same file is a blocking conflict). Pure. |
| `planning.ts` | Stages ②③④. `runPlanning` clones the repo, spawns decompose → sequential flight-plan → align agents, reads their `.nyx/pipeline/*.json` artifacts. Spawn is **dependency-injected** (`PlanningDeps`) for testability; the real path mirrors composer/plan-spawner's Max-plan env strip. |
| `execute.ts` | Stage ⑤, PHASE-SCOPED. `runExecuting` runs the run's CURRENT phase's coders in topological waves (`scheduleWaves`, ≤ cap) — each in its own worktree off the LIVE integration branch (carries prior phases' merges), committing to its own branch — sets the base up once (reused across phases) + accumulates `coder_results`. `scheduleWaves` pure + tested; `defaultRunCoder` (real git worktree + spawn + commit) injected. Coder prompt = `renderCoderSpec(plan)` — scoped spec, never the goal. |
| `redux.ts` | Stage ⑥ (composer stages 1–3 promoted), PHASE-SCOPED to `current_phase`'s tasks. `harvestFacts` → `judgeP1` (deterministic conflict/failed override) → `judgeP2` cross-worktree interface graph (final arbiter; remediation + catastrophic) → `decideMerges` (pure — **interface gate**: merges only if P1-clean ∧ P2-fits ∧ every `deps`/`consumes` producer also merges, fixpoint) → `runMergeQueue` (authoritative). Persists `redux_findings`/`remediation_plan` for the phase. Judges injected; git real (temp-repo tests). |
| `shipping.ts` | Final smoke only (per-phase recovery now lives in executing). `runShipping` runs `defaultSmoke` once → green / review. **`defaultSmoke` is HERMETIC**: pristine `checkout/reset/clean` + verify-only prompt + post-run `git status` dirty-guard (`interpretSmoke`) — a verifier that mutates the tree fails the run. **`runDiagnosticRound`** (exported, used by the executing phase loop) re-implements held tasks from a clean integration baseline + only ADOPTS a fix that landed in-scope (`classifyDiagnosticFix`). `buildReviewBrief` pure. `MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS=2`. |
| `delivery.ts` | Stage ⑨ (terminal A). `runDelivery`: push the integration branch + open a PR WITHOUT auto-merge (`openDeliveryPR`, injected), `detectPipelineDeploy` (changedFiles × repo `deployPatterns` → reuse `task.production.deploy_required`), `buildDeliveryBrief` (pure), `cleanupRunArtifacts` (remove base + worktrees). The orchestrator emits the `pipeline.delivered` marker with the PR result. |
| `orchestrator.ts` | The state-machine driver. `advancePipeline` (segment loop), `createPipelineRun`, `resumeDecidedRuns` (tick priority 1), the stage segments + gate handlers. Planning is injected (`AdvanceDeps.plan`) so the orchestration is unit-testable with a canned `PlanningResult`. `_setBriefsDir` test seam. |
| `decide.ts` | `submitDecision` — the single chokepoint both the CLI and the portal call. Validates the decision against the run's current gate, records it, emits `pipeline.decision.submitted`. |

Wiring outside this dir:
- `cli/run-once.ts` — `handlePipelineInTick` (find-or-create + advance, bypasses inFlight/3-strike) + the `resumeDecidedRuns` pre-pass at tick top.
- `cli/pipeline.ts` + `scripts/nyx-pipeline.sh` — `nyx pipeline list|status|go|revise|proceed|fix|rollback|abort`.
- `remote-actions.ts` — `pipeline_decision` action (portal path) → `submitDecision`.
- `notifier.ts` — `pipelineAwaitingGate` (alert-only Slack ping).

---

## State machine

`planning → awaiting_preview → executing → shipping → done`, with
`replanning` (revise loop), `awaiting_review` (the late review gate), and
`aborted`/`failed` sinks. The table lives in `state-machine.ts`; the spec has the
prose version. Every `updateRun` that changes status goes through
`orchestrator.ts::transition`, which `assertTransition`s first.

## The two gates

- **Preview (mandatory, loops):** fires after planning. `go` freezes the plan +
  starts execution; `revise` re-runs planning with the operator's note (the note
  rides on `operator_decision` into `replanning`, consumed there); `abort` stops.
- **Review (conditional, late):** fires from shipping only when issues survive
  autonomous fixes (built in step 5). `proceed`/`fix`/`rollback`/`abort`.

The run PERSISTS at `awaiting_*` and the tick exits. `resumeDecidedRuns`
advances it on the next tick once `operator_decision` is set. The plan freezes
at planning time into `plan_json` and is treated as immutable after `go` (the
scope-creep contract).

## Decisions baked in (don't relitigate without the spec)

1. **Synchronous segments** (decision A): a tick runs a whole autonomous segment
   then exits at the next gate. A long segment holding `claude` blocks later
   ticks via `hasLiveClaude` — same as any long task.
2. **Run is self-contained** — `repo` + `prompt` + `plan_json` live on the row,
   so cross-tick resume never needs the original queue task in scope.
3. **Planning agents are NOT blind** — spawned in a real clone with Bash/Read/
   Grep, unlike dispatch-mode decompose.
4. **Spawn + planning are dependency-injected** — the state-machine orchestration
   is fully unit-tested with canned output; no real `claude` in tests.
5. **5-min tick** (v0.18) — the slot grid stays 15 min; extra ticks only advance
   pipeline runs. See `config/launchd/com.nyx.dispatcher.plist`.
6. **Coders get the SCOPED compiled spec, never the operator goal** (v0.22.3,
   `renderCoderSpec`) AND the merge queue holds a consumer whose producer is held
   (the `decideMerges` interface gate). These two are what make isolated parallel
   coders actually safe — without them a coder does a sibling's job and the merge
   commits a branch importing code that never landed. Do NOT regress by feeding
   `run.prompt` to coders or merging on per-task verdicts alone. See
   [T4 2026-06-04-pipeline-coder-scope-leak-orphan-merge].
7. **Executing is PHASED, one phase per tick** (v0.23). Sequential work (code →
   its tests → wiring) is split into phases by the decomposer; each phase's
   coders branch off the integration branch AFTER prior phases merged, so they
   build on REAL code, not stubs. `consumes` is same-phase only. A phase must
   merge all-clean (after R1/R2) to unlock the next; otherwise → review. Do NOT
   collapse phases into one flat wave off a frozen base (the bug this replaced),
   and do NOT merge a module + its tests into one task to sequence them — use
   phases. Yield: `advancePipeline` releases the tick when a segment returns its
   status unchanged (executing→executing).

## Where to put new work (post-v1 — the 6-step build is done)

- **v2 delivery** — autonomous deploy + CI-wait + deploy-failure R3 + auto-migrate
  (gated on auto-deploy infra; respects the manual-deploy / no-auto-migrate
  invariants in [T1 §3.2]). Today delivery stops at PR-ready.
- **Concurrency** — raise `config.pipelineCoderConcurrency` (start 4) as
  rate-limit behavior is observed; consider detached background segments if
  queue starvation appears (today segments run synchronously per tick).
- **Failure cleanup** — `failed` runs preserve `worktree_base` for inspection (by
  design); add a GC for abandoned bases if they accumulate.
- **Operator activation still pending** — the 5-min launchd reload + the portal
  `pipeline_decision` CHECK-constraint migration + brief-rendering UI (see
  [T5 scaffold/prompt-to-product-pipeline.md] "Final setup").
- **Fill `stageShipping`** (step 5) — R1/R2 reuse the audit-phase diagnostic;
  smoke via an independent supervisor; route to `awaiting_review` on unresolved.
- **A new pipeline audit event** → add to the `AuditEvent` union in `audit.ts`.

## Testing pattern

`_setPipelineDb(new DatabaseSync(':memory:'))` + `_setAuditDb(...)` (audit fires
from orchestrator paths). Inject `AdvanceDeps.{plan,execute,redux,ship,deliver}`
to avoid real spawns/clones/PRs; inject `PlanningDeps.spawn` / `ReduxDeps.judge*`
/ `ShippingDeps.{diagnose,smoke}` + a tmp dir to test the engines without a
subprocess. `_setBriefsDir(tmp)` keeps gate briefs out of the real data dir.
**`_setNotificationsEnabled(false)` is REQUIRED** in any test that drives the
orchestrator — the lifecycle/gate pings (`pipelineRunStarted`, `pipelineResumed`,
`pipelineAwaitingGate`, `pipelineDelivered`) call the real Slack API otherwise.
See `__tests__/pipeline*.test.ts`.

## Operator notifications (Slack)

Every pipeline checkpoint pings the operator (via `notifier.ts`, alert-only):
run started (pickup) → preview gate reached → preview decision received → review
gate reached (if any) → review decision received → delivered. The gate-reached
pings list the concrete `nyx pipeline …` commands (the portal approval UI
isn't built; CLI is the surface).

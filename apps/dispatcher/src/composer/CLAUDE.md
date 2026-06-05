# Composer Layer (Tier 3)

> Tier 3 doc for the composer module. [Tier 2: `~/Nyx/CLAUDE.md`] auto-loads
> alongside this. [Tier 1: `~/.claude/CLAUDE.md`] for cross-stack invariants.
>
> The composer layer is **stage 0 — observation only**. It logs conflicts to a
> queryable table and never blocks task execution. This doc explains why, what
> it does, and how to move it through stages 1-3.
>
> **⚠️ As of the desktop-settings release, the stage-0 composer RUN is no longer
> invoked for non-pipeline (`[type: code]`) tasks** — the plan-only +
> composer-check spawns before code-task execution were a proof-of-concept and
> were removed (`run-once.ts` no longer calls `runComposerLayer`; code tasks run
> a single execution spawn). This module is retained for the pipeline's
> composer-redux stage and as the basis for any future staged promotion.

---

## Why this exists

Before the composer layer, Nyx's chain-mode (`[depends:]`) tasks executed
in sequence with no cross-task coordination. Each agent saw only its own task
description plus the codebase state at dispatch time. When task N depended on
task N-1, task N planned against pre-N-1 state, then N-1 changed shape
mid-chain, and N's assumptions were already stale by the time it executed.

This failure mode produced the MKTG-V5 integration cascade (May 2026) where 5
tasks all touched `audit_log/router.py`, `auth.py`, `pipeline/routes.py` with
no shared signature contract — frontend hit `/audit-log`, backend served
`/audit/`; two `Post` ORM classes mapped to one table; pipeline router lacked
the JWT dep its siblings had. Each individually-correct task produced a broken
integration.

The composer layer's job: validate chain coherence BEFORE execution.

---

## What it actually does (stage 0)

For every `type: code` task that has `[depends:]` ancestors, the dispatcher:

1. **Plan phase** — spawns `claude -p` with a planning prompt. Agent reads the
   repo, writes a flight plan JSON to `.nyx/flight-plan.json`, exits.
   Read-only tools + Write (for the plan file). No commits. Plan is parsed,
   validated for shape, saved to `flight_plans` table. The `.nyx/` dir is
   deleted before phase 3 so it doesn't get committed.

2. **Composer phase** — spawns another `claude -p` with the new task's plan
   + all ancestor plans + git diffs of ancestor commits. Composer outputs a
   JSON array of findings (file conflicts, interface mismatches, etc.) to
   stdout. Findings persist to `composer_findings` table.

3. **Execution phase** — the EXISTING dispatcher flow (`attemptTask` in
   `cli/run-once.ts`), unchanged, but with the flight plan injected into the
   prompt as context. The agent now executes its own previously-drafted plan.

**Stage 0 invariant: nothing the composer layer does can block, fail, or
otherwise affect task execution.** Plan phase failed? Audit-log and skip.
Composer phase errored? Audit-log and skip. The task runs the same way it
would have without the composer layer existing.

---

## Alignment passes MUST check T5 (pending proposals)

When the composer normalizes a spec (stage 1+) or a planning agent scopes a
refactor, it MUST consult [T5: `~/Nyx/scaffold/INDEX.md`] and consider any
proposal touching the affected modules. A pending proposal may already dictate
a folder layout, table shape, or memory structure — the composer must not
normalize toward a contradicting shape. Example: while
`nyx-folder-restructure.md` is in T5, don't compose a task that invents a
different `~/nyx/` layout. The composer isn't acting on the proposal; it's
avoiding pre-empting a decision already in flight. See [T1 §7 — T5 consultation
discipline] and [ADR 0003].

---

## File map

| File | Role |
|---|---|
| `types.ts` | TypeScript types — `FlightPlan`, `ComposerFinding`, `ComposerRunResult`. |
| `db.ts` | SQLite tables (`flight_plans`, `composer_runs`, `composer_findings`) + `_setComposerDb()` test hook. |
| `plan-spawner.ts` | Phase 1 — spawns plan-only claude, parses `.nyx/flight-plan.json`. Includes `validateFlightPlanShape` (lenient validator) + `removeFlightPlanArtifact` (cleanup). |
| `chain-context.ts` | Gathers ancestor flight plans + git diffs. Scope: immediate `[depends:]` parents only per operator decision 5. |
| `composer-runner.ts` | Phase 2 — spawns composer claude, parses findings, persists. Includes `parseComposerOutput` (lenient JSON extractor). |
| `orchestrate.ts` | Public entry point — `runComposerLayer(task, workingDir)`. Wraps phases 1+2 with the "never throw, never block" guarantee. |

---

## Stage roadmap

This module is stage 0. Stages 1-3 reuse the same primitives — the table
schema, the `runComposer` plumbing, the flight-plan format. What changes
across stages is **what the dispatcher does with composer findings**, not
the composer itself.

| Stage | What changes |
|---|---|
| **Stage 0** (current) | Findings logged, never block. Data feeds v1+ design. |
| **Stage 1** | Reconciler upgrade: replace `[expects:]` file-existence check with real plan-vs-output diff. New `task.reconciler.divergence` audit event. Adds AST-light signature extraction for TS/Python (other languages: string match). Required before stage 2 (composer needs reliable signature data from ancestor diffs). |
| **Stage 2** | High-confidence findings (`severity: block_recommended` + categories proven precise by stage 0 data) transition from logging to halting. Per-category enable: `nyx composer-block <kind> {on,off}`. |
| **Stage 3** | Real commit queue + parallel execution. Requires the parallelization work the rest of the system is trending toward. GitHub Actions webhook ingestion for CI-passed signals. |

The gate from stage 0 → stage 1 is data: how often does the composer find
real issues, and at what precision per category? Without that, stage 2's
per-category enable would be guesswork.

---

## Decisions baked in (do not relitigate without strong reason)

1. **Two-phase spawn (separate plan + execute calls)** — not in-prompt
   "first write the plan then continue" because the plan would not be
   inspectable until after the agent had also done the code work.
2. **`claude -p` subprocess for the composer call** (not direct API) — uses
   Max plan; cost is irrelevant within current usage envelope. See [T2 §1].
3. **Sonnet for the composer** — escalate to Opus only if precision/recall
   becomes unacceptable.
4. **Findings live in `composer_findings`, NOT the audit chain** — they're
   training data for v1+, not lifecycle events. Task-lifecycle events around
   plan emission (`task.flight_plan.submitted`, `.missing`, `.invalid_json`)
   DO go in the audit chain because they describe what happened to the task.
5. **Immediate `[depends:]` parents only** — full ancestor closure is stage 1+.
6. **No retry on missing flight plan** — log and proceed. Plan-emission rate
   itself is a signal worth measuring before adding complexity.

---

## Cost shape

Per code task with `[depends:]` ancestors:
- Phase 1: 1 spawn (planning). Roughly same cost as a small assistant task.
- Phase 2: 1 spawn (composer). Smaller context — just plans + diffs.
- Phase 3: 1 spawn (existing execution).

For code tasks WITHOUT `[depends:]`, the composer layer can be skipped entirely
(no ancestors → composer has nothing to validate). Currently the layer still
runs phase 1 (collects the plan for downstream tasks' use) but phase 2's
finding count will be 0 or near-0. Future optimization: skip phase 2 when
ancestors is empty.

---

## Testing pattern

Tests use `_setComposerDb(new DatabaseSync(':memory:'))` matching the
`_setAuditDb` / `_setSecretsDb` pattern in T2's testing rules. Critical:
tests that exercise audit() must ALSO stub the audit DB to `:memory:`,
because audit events fire from composer code paths.

See `apps/dispatcher/__tests__/composer.test.ts` for the canonical example.

---

## Where to put new composer features

- **A new finding kind** → add to `FindingKind` union in `types.ts`, the
  `VALID_KINDS` array in `composer-runner.ts`, and the finding-category
  descriptions in `buildComposerPrompt`. Update the composer prompt's
  category list so the agent knows about it.
- **A new flight-plan field** → add to `FlightPlan` in `types.ts`, bump
  `FLIGHT_PLAN_SCHEMA_VERSION` (lenient validator rejects mismatches),
  update `buildPlanPrompt` to document the new field, update
  `validateFlightPlanShape` to coerce/default it.
- **A new composer audit event** → add to the `AuditEvent` union in
  `audit.ts`. The compiler will catch all call sites that need updating.

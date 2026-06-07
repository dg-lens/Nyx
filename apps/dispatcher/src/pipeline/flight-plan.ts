/**
 * Pipeline planning data: the internal task DAG, the flight-plan interface
 * contract, the composer-alignment output, and the preview-brief renderer.
 *
 * This is the pure layer — types + lenient parsers + a markdown brief builder.
 * No I/O, no spawning. `planning.ts` produces these by spawning agents; the
 * orchestrator freezes them into `pipeline_runs.plan_json` at the preview "go".
 *
 * The flight-plan contract here is RICHER than composer/types.ts `FlightPlan`:
 * it adds `consumes` (the synchronicity link — symbols a task expects from its
 * siblings) and `scope_boundary` (what it must NOT touch — the scope-drift
 * detector for composer redux). Composer's FlightPlan is the stage-0 format;
 * this is the pipeline contract that step 4's interface graph walks.
 */

// ─── Internal task DAG (stage ②) ──────────────────────────────────────────────

export interface DagNode {
  id: string;
  description: string;
  deps: string[];
  /** Pipeline sub-tasks are code or analysis; never assistant/content. */
  type: 'code' | 'analysis';
  target_paths: string[];
  /**
   * 0-based phase. Phases run SEQUENTIALLY with a merge between: phase k's coders
   * branch off the integration branch AFTER phases 0..k-1 merged, so a later
   * phase sees the earlier phases' REAL code (e.g. tests in a later phase run
   * against the actually-merged module). Tasks within a phase run concurrently
   * + isolated (interface contracts). Declared by the decomposer.
   */
  phase: number;
}

export interface TaskDag {
  nodes: DagNode[];
}

// ─── Flight-plan interface contract (stage ③) ─────────────────────────────────

export interface CreatesItem {
  symbol: string;
  signature: string;
  file: string;
  purpose: string;
}

/** A symbol this task expects to exist, produced by a sibling task. */
export interface ConsumesItem {
  from_task: string;
  symbol: string;
  expected_signature: string;
}

export interface FlightPlanContract {
  task_id: string;
  description: string;
  /** 0-based phase (carried from the DAG node). See DagNode.phase. */
  phase: number;
  deps: string[];
  /** Symbols/files this task will ADD, with signatures. */
  creates: CreatesItem[];
  /** Files this task will CHANGE. */
  modifies: string[];
  /** Symbols from sibling tasks this task depends on — the synchronicity link. */
  consumes: ConsumesItem[];
  /** Env vars / secrets / accounts / repos needed at execution time. */
  preflight: string[];
  /** What this task must NOT touch — enables scope-drift detection. */
  scope_boundary: string[];
  /** How to verify the task is done. */
  acceptance: string[];
}

// ─── Composer alignment (stage ④) ─────────────────────────────────────────────

export type ConflictKind =
  | 'interface_mismatch'
  | 'contradiction'
  | 'overlap'
  | 'missing_dep'
  | 'preflight_gap'
  | 'other';

export interface AlignmentConflict {
  kind: ConflictKind;
  detail: string;
  /** Task IDs involved. */
  involved: string[];
  /** True if the operator must answer this before execution can proceed. */
  needs_operator: boolean;
}

export type PreflightStatus = 'ready' | 'missing' | 'unclear';

export interface PreflightItem {
  item: string;
  status: PreflightStatus;
  note: string;
  env?: string; // exact env var name when the requirement is an env var / secret
}

export interface AlignmentDecision {
  question: string;        // a yes/no decision the operator must make that the prompt didn't scope
  default?: 'yes' | 'no';  // the planner's suggested answer, if any
}

export interface Alignment {
  conflicts: AlignmentConflict[];
  preflight: PreflightItem[];
  decisions: AlignmentDecision[];
}

// ─── Aggregate plan (frozen at "go") ──────────────────────────────────────────

export interface PlanningResult {
  dag: TaskDag;
  plans: FlightPlanContract[];
  alignment: Alignment;
}

// ─── Lenient parsers ──────────────────────────────────────────────────────────
//
// Agents write JSON artifacts; these coerce/default missing fields rather than
// reject, matching composer/plan-spawner.ts::validateFlightPlanShape. Returns
// null only when the input isn't a usable object/array.

function arrOfStr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function arrOfObj(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Parse JSON from raw agent output. Tolerates a leading/trailing prose by
 * extracting the first balanced `{...}` or `[...]` block. */
export function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to bracket extraction */
  }
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseDag(raw: string): TaskDag | null {
  const json = extractJson(raw);
  if (!json) return null;
  // Accept either {nodes:[...]} or a bare [...] of nodes.
  const rawNodes = Array.isArray(json)
    ? json
    : ((json as Record<string, unknown>).nodes ?? (json as Record<string, unknown>).tasks);
  const nodes = arrOfObj(rawNodes).map((n): DagNode => ({
    id: str(n.id),
    description: str(n.description),
    deps: arrOfStr(n.deps),
    type: n.type === 'analysis' ? 'analysis' : 'code',
    target_paths: arrOfStr(n.target_paths),
    phase: typeof n.phase === 'number' && n.phase >= 0 ? Math.floor(n.phase) : 0,
  })).filter((n) => n.id.length > 0);
  if (nodes.length === 0) return null;
  return { nodes };
}

export function parseFlightPlanContract(raw: string, fallbackTaskId = ''): FlightPlanContract | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  const taskId = str(r.task_id, fallbackTaskId);
  if (!taskId) return null;
  return {
    task_id: taskId,
    description: str(r.description),
    phase: typeof r.phase === 'number' && r.phase >= 0 ? Math.floor(r.phase) : 0,
    deps: arrOfStr(r.deps),
    creates: arrOfObj(r.creates).map((c): CreatesItem => ({
      symbol: str(c.symbol),
      signature: str(c.signature),
      file: str(c.file),
      purpose: str(c.purpose),
    })),
    modifies: arrOfStr(r.modifies),
    consumes: arrOfObj(r.consumes).map((c): ConsumesItem => ({
      from_task: str(c.from_task),
      symbol: str(c.symbol),
      expected_signature: str(c.expected_signature),
    })),
    preflight: arrOfStr(r.preflight),
    scope_boundary: arrOfStr(r.scope_boundary),
    acceptance: arrOfStr(r.acceptance),
  };
}

export function parseAlignment(raw: string): Alignment {
  const json = extractJson(raw);
  const r = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const conflicts = arrOfObj(r.conflicts).map((c): AlignmentConflict => ({
    kind: (['interface_mismatch', 'contradiction', 'overlap', 'missing_dep', 'preflight_gap', 'other'].includes(
      c.kind as string,
    )
      ? c.kind
      : 'other') as ConflictKind,
    detail: str(c.detail),
    involved: arrOfStr(c.involved),
    needs_operator: c.needs_operator === true,
  }));
  const preflight = arrOfObj(r.preflight).map((p): PreflightItem => ({
    item: str(p.item),
    status: (['ready', 'missing', 'unclear'].includes(p.status as string) ? p.status : 'unclear') as PreflightStatus,
    note: str(p.note),
    ...(p.env ? { env: str(p.env) } : {}),
  }));
  const decisions = arrOfObj(r.decisions).map((d): AlignmentDecision => ({
    question: str(d.question),
    ...(d.default === 'yes' || d.default === 'no' ? { default: d.default } : {}),
  }));
  return { conflicts, preflight, decisions };
}

// ─── Plan freeze / thaw ───────────────────────────────────────────────────────

/**
 * Renumber phase values to a dense, contiguous, zero-based sequence so the raw
 * `phase` number always equals its position in `groupPhases()`'s dense array.
 * The decomposer is an LLM and `parseDag`/`parseFlightPlanContract` accept ANY
 * non-negative integer phase (gaps, non-zero base), but the orchestrator walks
 * `current_phase` as a dense index into `groupPhases()` while `runExecuting`/
 * `runRedux` filter tasks by the raw `phase` number — the two only agree when
 * phases are exactly 0,1,2,…. Normalizing at freeze time makes them coincide for
 * every input. Pure: maps the sorted distinct phase values to 0..n-1 across both
 * `dag.nodes` and `plans`.
 */
function normalizePhases(result: PlanningResult): PlanningResult {
  const distinct = [
    ...new Set([
      ...result.dag.nodes.map((n) => (Number.isInteger(n.phase) && n.phase >= 0 ? n.phase : 0)),
      ...result.plans.map((p) => (Number.isInteger(p.phase) && p.phase >= 0 ? p.phase : 0)),
    ]),
  ].sort((a, b) => a - b);
  const denseOf = new Map(distinct.map((v, i) => [v, i]));
  const remap = (phase: number): number => denseOf.get(Number.isInteger(phase) && phase >= 0 ? phase : 0) ?? 0;
  return {
    ...result,
    dag: { nodes: result.dag.nodes.map((n) => ({ ...n, phase: remap(n.phase) })) },
    plans: result.plans.map((p) => ({ ...p, phase: remap(p.phase) })),
  };
}

export function freezePlan(result: PlanningResult): string {
  return JSON.stringify(normalizePhases(result));
}

export function parsePlanJson(json: string | null): PlanningResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as PlanningResult;
    if (!r || typeof r !== 'object' || !Array.isArray(r.plans) || !r.dag) return null;
    return r;
  } catch {
    return null;
  }
}

// ─── Preview-brief renderer ───────────────────────────────────────────────────

const STATUS_ICON: Record<PreflightStatus, string> = { ready: '✅', missing: '⚠️', unclear: '❓' };

/**
 * Render the preview-gate brief as markdown. The portal renders this; the CLI
 * prints it. Pure — given the same plan it always produces the same brief.
 */
/**
 * One-line go/no-go headline for the preview gate. Shared by the brief (top
 * line) and the Slack ping — the operator should be able to decide from this
 * alone. GO when nothing needs input; NEEDS INPUT (with the counts) otherwise.
 */
export function previewRecommendation(result: PlanningResult): string {
  const tasks = result.dag.nodes.length;
  const phases = new Set(result.dag.nodes.map((n) => n.phase)).size;
  const gaps = result.alignment.preflight.filter((p) => p.status !== 'ready');
  const blocking = result.alignment.conflicts.filter((c) => c.needs_operator);
  if (blocking.length || gaps.length) {
    const bits: string[] = [];
    if (blocking.length) bits.push(`${blocking.length} question${blocking.length === 1 ? '' : 's'} to answer`);
    if (gaps.length) bits.push(`${gaps.length} preflight gap${gaps.length === 1 ? '' : 's'}`);
    return `NEEDS INPUT — ${bits.join(' · ')} (${tasks} tasks / ${phases} phases)`;
  }
  return `GO — ${tasks} tasks across ${phases} phase${phases === 1 ? '' : 's'}; preflight clear, no blocking questions`;
}

/**
 * Preview-gate brief: recommendation + decide commands on top, then ONLY what
 * needs attention (blocking questions, preflight gaps), then a collapsed plan
 * outline. The full flight-plan detail lives in `plan_json`, not here — the
 * brief stays scannable.
 */
export function buildPreviewBrief(runId: string, _prompt: string, result: PlanningResult): string {
  const { dag, alignment } = result;
  const blocking = alignment.conflicts.filter((c) => c.needs_operator);
  const gaps = alignment.preflight.filter((p) => p.status !== 'ready');
  const L: string[] = [];
  L.push(`# Preview gate — ${runId}`);
  L.push('');
  L.push(`**${previewRecommendation(result)}**`);
  L.push('');
  L.push('```');
  L.push(`nyx pipeline go ${runId}        # freeze plan + start coding`);
  L.push(`nyx pipeline revise ${runId} --note "..."   # re-plan with input`);
  L.push(`nyx pipeline abort ${runId}`);
  L.push('```');

  if (blocking.length) {
    L.push('');
    L.push('## ⚠️ Answer before go');
    for (const c of blocking) L.push(`- ${c.detail} [${c.involved.join(', ')}]`);
  }
  if (gaps.length) {
    L.push('');
    L.push('## Preflight to confirm');
    for (const g of gaps) L.push(`- ${STATUS_ICON[g.status]} ${g.item}${g.note ? ` — ${g.note}` : ''}`);
  }

  L.push('');
  L.push('<details><summary>Plan outline</summary>');
  L.push('');
  const phaseNums = [...new Set(dag.nodes.map((n) => n.phase))].sort((a, b) => a - b);
  for (const k of phaseNums) {
    const inPhase = dag.nodes.filter((n) => n.phase === k);
    L.push(`**Phase ${k}** — ${inPhase.map((n) => n.id).join(', ')}`);
    for (const n of inPhase) L.push(`- ${n.id}: ${n.description}`);
  }
  L.push('</details>');
  return L.join('\n');
}

/** True if any alignment conflict requires an operator answer. */
export function hasBlockingConflicts(result: PlanningResult): boolean {
  return result.alignment.conflicts.some((c) => c.needs_operator);
}

/**
 * Compile a flight-plan contract into the SCOPED, self-contained prompt for its
 * coder. This is the whole point of the flight-plan/composer step: each coder
 * gets ONLY its slice, never the overall operator goal — so it cannot wander
 * into a sibling's work, and isolated coders can run concurrently and still
 * assemble. `consumes` is rendered as "a sibling provides this; do NOT build
 * it"; `scope_boundary` + the creates/modifies allow-list are hard limits.
 *
 * Pure + deterministic on purpose: scoping is safety-critical and must not vary
 * run to run. The contract IS the scoped spec; this renders it.
 */
export function renderCoderSpec(plan: FlightPlanContract): string {
  const L: string[] = [];
  L.push(`# Coder task: ${plan.task_id}`);
  L.push('');
  L.push('You are ONE coder in a parallel autonomous build. Implement EXACTLY the slice below — nothing else. You do NOT see, and must NOT do, any other task\'s work. Sibling coders run concurrently in their own worktrees; their code is NOT in your tree, and that is expected.');
  L.push('');
  L.push('## What this task is');
  L.push(plan.description || '(see the create/modify lists below)');
  L.push('');

  L.push('## Create exactly these (and nothing else)');
  if (plan.creates.length) {
    for (const c of plan.creates) {
      L.push(`- \`${c.symbol}\`${c.signature ? `: ${c.signature}` : ''} in \`${c.file}\`${c.purpose ? ` — ${c.purpose}` : ''}`);
    }
  } else {
    L.push('- (creates nothing new)');
  }
  L.push('');

  L.push('## You may modify ONLY these files');
  L.push(plan.modifies.length ? plan.modifies.map((f) => `- \`${f}\``).join('\n') : '- (modify nothing — create-only task)');
  L.push('');

  if (plan.consumes.length) {
    L.push('## Provided by sibling coders — use as if they exist, do NOT create them');
    for (const c of plan.consumes) {
      L.push(`- \`${c.symbol}\`${c.expected_signature ? ` (${c.expected_signature})` : ''} from task ${c.from_task} — import/call it against this signature; it is NOT your job to define it, and it will NOT be present in your worktree.`);
    }
    L.push('');
  }

  L.push('## HARD scope — violating any of these fails the task at the merge gate');
  L.push('- Create ONLY the files implied by the "create" list. Modify ONLY files in the "modify" list.');
  L.push('- Do NOT create, edit, or delete ANY other file — not sibling source, not test files that aren\'t yours, not config, not docs.');
  if (plan.scope_boundary.length) for (const b of plan.scope_boundary) L.push(`- Off-limits: ${b}`);
  L.push('');

  if (plan.acceptance.length) {
    L.push('## Done when (for YOUR slice only)');
    for (const a of plan.acceptance) L.push(`- ${a}`);
    L.push('- Do NOT try to make the whole system build/pass — siblings\' code is absent by design. Composer redux + smoke verify the assembled whole.');
    L.push('');
  }

  L.push('Commit your work with a clear message and exit.');
  return L.join('\n');
}

/**
 * Detect tasks whose `creates`/`modifies` file sets intersect — a scope overlap
 * the composer must surface so two coders don't both author the same file (the
 * exact failure mode where one coder clobbers another's file). Pure. Returns
 * one blocking conflict per overlapping pair.
 */
export function detectScopeOverlaps(plans: FlightPlanContract[]): AlignmentConflict[] {
  const filesOf = (p: FlightPlanContract): Set<string> =>
    new Set([...p.creates.map((c) => c.file).filter(Boolean), ...p.modifies]);
  const out: AlignmentConflict[] = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i]!;
      const b = plans[j]!;
      const fa = filesOf(a);
      const shared = [...filesOf(b)].filter((f) => fa.has(f));
      if (shared.length) {
        out.push({
          kind: 'overlap',
          detail: `Tasks ${a.task_id} and ${b.task_id} both write the same file(s): ${shared.join(', ')}. Two coders cannot author the same file in isolation — re-scope so each file has exactly one owner.`,
          involved: [a.task_id, b.task_id],
          needs_operator: true,
        });
      }
    }
  }
  return out;
}

/**
 * Topological order of task ids by their `deps` (Kahn's; in-set deps only).
 * Nodes left over by a cycle are appended in original order. Used by the merge
 * queue so dependencies integrate before dependents.
 */
/**
 * Group flight plans into ordered phases (by `phase`, ascending). Returns an
 * array indexed by phase number — `phases[k]` is the tasks of phase k. Empty
 * phase slots (gaps in the declared numbers) collapse so indices are dense:
 * the result is the non-empty phase buckets in ascending phase order.
 */
export function groupPhases(plans: FlightPlanContract[]): FlightPlanContract[][] {
  const byPhase = new Map<number, FlightPlanContract[]>();
  for (const p of plans) {
    const k = Number.isInteger(p.phase) && p.phase >= 0 ? p.phase : 0;
    if (!byPhase.has(k)) byPhase.set(k, []);
    byPhase.get(k)!.push(p);
  }
  return [...byPhase.keys()].sort((a, b) => a - b).map((k) => byPhase.get(k)!);
}

export function topoOrderOf(items: Array<{ task_id: string; deps: string[] }>): string[] {
  const ids = new Set(items.map((i) => i.task_id));
  const indeg = new Map(items.map((i) => [i.task_id, i.deps.filter((d) => ids.has(d)).length]));
  const queue = items.filter((i) => (indeg.get(i.task_id) ?? 0) === 0).map((i) => i.task_id);
  const out: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const i of items) {
      if (i.deps.includes(id)) {
        indeg.set(i.task_id, (indeg.get(i.task_id) ?? 1) - 1);
        if ((indeg.get(i.task_id) ?? 0) === 0) queue.push(i.task_id);
      }
    }
  }
  for (const i of items) if (!seen.has(i.task_id)) out.push(i.task_id);
  return out;
}

/**
 * Pipeline planning engine (stages ②③④).
 *
 * Unlike dispatch-mode decompose (no Bash/gh — blind), planning agents are
 * spawned IN the target repo with read/explore tools, so they plan against the
 * real layout. Three stages:
 *   ② decompose  — one agent → internal task DAG
 *   ③ flight-plan — one agent PER task, run SEQUENTIALLY so each sees the prior
 *                   plans and aligns interfaces (the "synchronicity" link)
 *   ④ align       — one agent → cross-plan conflicts + preflight checklist
 *
 * Spawning is dependency-injected (`PlanningDeps`) so the orchestration is
 * unit-testable with canned agent output; production wires the real Max-plan
 * `claude -p` spawn (env-stripped, matching composer/plan-spawner.ts) and clones
 * the repo via git-ops. Agents write JSON artifacts to `.nyx/pipeline/`,
 * which this module reads + leniently parses (flight-plan.ts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import * as git from '../git-ops.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import {
  detectScopeOverlaps,
  parseAlignment,
  parseDag,
  parseFlightPlanContract,
  type Alignment,
  type DagNode,
  type FlightPlanContract,
  type PlanningResult,
  type TaskDag,
} from './flight-plan.js';
import type { PipelineRun } from './types.js';

const PLAN_TIMEOUT_MS = 5 * 60_000;
const PLAN_SUBDIR = '.nyx/pipeline';
export const DAG_ARTIFACT = `${PLAN_SUBDIR}/dag.json`;
export const ALIGN_ARTIFACT = `${PLAN_SUBDIR}/alignment.json`;
export function planArtifact(taskId: string): string {
  return `${PLAN_SUBDIR}/plan-${sanitize(taskId)}.json`;
}

const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'TodoWrite'];

// Per-stage models: cross-cutting reasoning (decompose/align) is opus-class;
// per-task flight-plan drafting is sonnet (many of them, cheaper). Tunable.
const DECOMPOSE_MODEL = 'opus';
const FLIGHT_PLAN_MODEL = 'sonnet';
const ALIGN_MODEL = 'opus';

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class PlanningError extends Error {}

/**
 * The minimum a planning pass needs: the task id, the operator prompt, and the
 * target repo (absent → plan against ~/Nyx via a local worktree). Built
 * from a ParsedTask at run creation OR reconstructed from the run row on a
 * cross-tick resume — the run is self-contained, so resume never needs the
 * original queue task in scope.
 */
export interface PlanTarget {
  id: string;
  description: string;
  repo?: string;
}

// ─── Dependency injection seam ────────────────────────────────────────────────

export interface PlanningSpawnArgs {
  prompt: string;
  model: string;
  workingDir: string;
  tools: string[];
  timeoutMs: number;
  label: string;
}
export interface PlanningSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type PlanningSpawn = (args: PlanningSpawnArgs) => Promise<PlanningSpawnResult>;

export interface PlanningDeps {
  spawn: PlanningSpawn;
  /** Working dir to plan in. If absent, a clone/worktree is created + torn down. */
  workingDir?: string;
}

/** Production spawn: real `claude -p`, Max-plan env, stdout captured. */
const realSpawn: PlanningSpawn = async (a) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  const args = [
    '-p',
    a.prompt,
    '--model',
    a.model,
    '--permission-mode',
    config.claudePermissionMode,
    '--allowed-tools',
    a.tools.join(' '),
    '--add-dir',
    a.workingDir,
  ];
  const r = await spawnWithTimeout(
    'claude',
    args,
    { cwd: a.workingDir, env, captureStdout: true, label: a.label },
    a.timeoutMs,
  );
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

function defaultDeps(): PlanningDeps {
  return { spawn: realSpawn };
}

// ─── Working dir ──────────────────────────────────────────────────────────────

/** Clone the target repo (or local worktree if no repo) for planning agents. */
export function setupPlanningDir(run: PipelineRun, target: PlanTarget): git.WorkingDir {
  if (target.repo) {
    const baseBranch = config.gitTargets[target.repo]?.baseBranch;
    return git.cloneExternalRepo(run.id, target.repo, 1, baseBranch ? { baseBranch } : {});
  }
  return git.createLocalWorktree(run.id);
}

function readArtifact(workingDir: string, rel: string): string | null {
  const p = resolve(workingDir, rel);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function clearArtifacts(workingDir: string): void {
  const dir = resolve(workingDir, PLAN_SUBDIR);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function decomposePrompt(target: PlanTarget, revisionNote: string | null): string {
  const L: string[] = [];
  L.push(`# Pipeline planning — decompose: ${target.id}`);
  L.push('');
  L.push('You are the DECOMPOSE stage of an autonomous coding pipeline. Read the repo to understand its real layout, then break the operator prompt into a minimal DAG of independently-executable sub-tasks. Do NOT modify source. Do NOT commit.');
  L.push('');
  L.push('## Operator prompt');
  L.push(target.description);
  if (target.repo) L.push(`\nRepo: ${target.repo}`);
  if (revisionNote) {
    L.push('');
    L.push('## Operator revision (incorporate this)');
    L.push(revisionNote);
  }
  L.push('');
  L.push('## Output');
  L.push(`Write JSON to \`${DAG_ARTIFACT}\` (mkdir the dir first) matching:`);
  L.push('```json');
  L.push(
    JSON.stringify(
      {
        nodes: [
          {
            id: 'SHOUTING-KEBAB id, unique within this run',
            description: 'one line: what this sub-task does',
            phase: 0,
            deps: ['ids of sub-tasks that must finish first'],
            type: 'code | analysis',
            target_paths: ['repo-relative paths this sub-task will touch'],
          },
        ],
      },
      null,
      2,
    ),
  );
  L.push('```');
  L.push('');
  L.push('## Phases — the most important structural decision');
  L.push('Group tasks into PHASES (0,1,2,…). Phases run SEQUENTIALLY with a real merge between them: when a phase finishes, its code is merged to the integration branch, and the NEXT phase\'s coders branch off that — so a later phase sees the earlier phases\' ACTUAL merged code.');
  L.push('- Tasks in the SAME phase run CONCURRENTLY in isolated worktrees — they CANNOT see each other\'s new code, so two same-phase tasks must NOT depend on code one of them is creating. If B needs A\'s new code, put B in a LATER phase than A.');
  L.push('- Canonical example: implementing a module and writing its tests are TWO phases — phase 0 creates the module, phase 1 writes/run the tests against the real merged module. Do NOT put them in the same phase, and do NOT merge them into one task.');
  L.push('- Wiring/integration that depends on several modules goes in a phase after them.');
  L.push('');
  L.push('## Rules');
  L.push('- One sub-task per coherent unit of work; use PHASES (not a giant task) to sequence dependent work.');
  L.push('- `deps` is for ordering within the plan; cross-phase dependencies are satisfied by real merged code, so a later-phase task need not list earlier-phase tasks in `deps` unless it helps clarity.');
  L.push('- Use Bash/Read/Grep to inspect the repo. Write ONLY the artifact file. Exit when done.');
  return L.join('\n');
}

function flightPlanPrompt(
  node: DagNode,
  priorPlans: FlightPlanContract[],
): string {
  const L: string[] = [];
  L.push(`# Pipeline planning — flight plan: ${node.id}`);
  L.push('');
  L.push('You are the FLIGHT-PLAN stage. Produce the interface contract for ONE sub-task. Sibling plans already drafted are shown below — align your interfaces with them (match the symbols/signatures you consume to what they create). Do NOT modify source. Do NOT commit.');
  L.push('');
  L.push('## This sub-task');
  L.push(`id: ${node.id}`);
  L.push(`description: ${node.description}`);
  L.push(`phase: ${node.phase}`);
  if (node.deps.length) L.push(`deps: ${node.deps.join(', ')}`);
  if (node.target_paths.length) L.push(`target paths: ${node.target_paths.join(', ')}`);
  L.push('');
  L.push('## Phase model (affects what you may consume)');
  L.push(`You are in phase ${node.phase}. Earlier phases are ALREADY MERGED into the integration branch by the time your coder runs — so any code from an earlier phase is REAL and present; you read/import it directly, you do NOT list it in \`consumes\`. \`consumes\` is ONLY for SAME-phase siblings (phase ${node.phase}), whose code runs concurrently and is NOT yet present — those you code against by contract.`);
  L.push('');
  const samePhasePriors = priorPlans.filter((p) => p.phase === node.phase);
  if (samePhasePriors.length) {
    L.push(`## Same-phase siblings already drafted (phase ${node.phase}) — align \`consumes\` to these`);
    L.push('```json');
    L.push(JSON.stringify(samePhasePriors, null, 2));
    L.push('```');
    L.push('');
  }
  L.push('## Output');
  L.push(`Write JSON to \`${planArtifact(node.id)}\` matching:`);
  L.push('```json');
  L.push(
    JSON.stringify(
      {
        task_id: node.id,
        description: node.description,
        phase: node.phase,
        deps: node.deps,
        creates: [{ symbol: 'name', signature: 'TS/Python signature', file: 'repo-relative path', purpose: 'one line' }],
        modifies: ['repo-relative paths you will change'],
        consumes: [{ from_task: 'SAME-phase sibling id', symbol: 'name', expected_signature: 'what you expect it to be' }],
        preflight: ['env vars / secrets / accounts / repos you need at execution time'],
        scope_boundary: ['files/areas you must NOT touch'],
        acceptance: ['how to verify this sub-task is done'],
      },
      null,
      2,
    ),
  );
  L.push('```');
  L.push('');
  L.push('## Rules');
  L.push('- `consumes` is the SAME-PHASE synchronicity link: every symbol you rely on from a same-phase sibling MUST match that sibling\'s `creates`. Do NOT list earlier-phase code in `consumes` — it is already on the branch; just use it.');
  L.push('- `scope_boundary` is what makes drift detectable later — be specific about what you will NOT touch.');
  L.push('- Inspect the repo with Bash/Read/Grep. Write ONLY the artifact file. Exit when done.');
  return L.join('\n');
}

function alignPrompt(prompt: string, dag: TaskDag, plans: FlightPlanContract[]): string {
  const L: string[] = [];
  L.push('# Pipeline planning — composer align');
  L.push('');
  L.push('You are the ALIGN stage. Given the full DAG + every flight plan, find cross-plan problems and assess execution preflight. Do NOT modify source.');
  L.push('');
  L.push('## Operator prompt');
  L.push(prompt);
  L.push('');
  L.push('## DAG');
  L.push('```json');
  L.push(JSON.stringify(dag, null, 2));
  L.push('```');
  L.push('');
  L.push('## Flight plans');
  L.push('```json');
  L.push(JSON.stringify(plans, null, 2));
  L.push('```');
  L.push('');
  L.push('## Output');
  L.push(`Write JSON to \`${ALIGN_ARTIFACT}\` matching:`);
  L.push('```json');
  L.push(
    JSON.stringify(
      {
        conflicts: [
          {
            kind: 'interface_mismatch | contradiction | overlap | missing_dep | preflight_gap | other',
            detail: 'one paragraph',
            involved: ['task ids'],
            needs_operator: 'true if the operator must answer before execution can proceed',
          },
        ],
        preflight: [
          { item: 'env var / secret / account / repo', status: 'ready | missing | unclear', note: 'one line' },
        ],
      },
      null,
      2,
    ),
  );
  L.push('```');
  L.push('');
  L.push('## Rules');
  L.push('- An `interface_mismatch` is when one task `consumes` a symbol another task does not `creates` (or with a different signature). These are the integration breaks that matter most.');
  L.push('- `overlap` is when two tasks modify the same file in conflicting ways.');
  L.push('- Set `needs_operator: true` ONLY for things you genuinely cannot resolve without operator input (missing secret, contradictory requirements). Everything else is advisory.');
  L.push('- Inspect the repo if helpful. Write ONLY the artifact file. Exit when done.');
  return L.join('\n');
}

// ─── Stage runners ────────────────────────────────────────────────────────────

export async function runDecompose(
  target: PlanTarget,
  workingDir: string,
  deps: PlanningDeps,
  revisionNote: string | null = null,
): Promise<TaskDag> {
  mkdirSync(resolve(workingDir, dirname(DAG_ARTIFACT)), { recursive: true });
  const res = await deps.spawn({
    prompt: decomposePrompt(target, revisionNote),
    model: DECOMPOSE_MODEL,
    workingDir,
    tools: PLAN_TOOLS,
    timeoutMs: PLAN_TIMEOUT_MS,
    label: 'pipeline-decompose',
  });
  const raw = readArtifact(workingDir, DAG_ARTIFACT);
  const dag = raw ? parseDag(raw) : null;
  if (!dag) {
    throw new PlanningError(
      `decompose produced no usable DAG (exit ${res.exitCode}). stderr: ${res.stderr.slice(-400)}`,
    );
  }
  return dag;
}

export async function runFlightPlans(
  dag: TaskDag,
  workingDir: string,
  deps: PlanningDeps,
): Promise<FlightPlanContract[]> {
  const ordered = topoSort(dag);
  const plans: FlightPlanContract[] = [];
  for (const node of ordered) {
    await deps.spawn({
      prompt: flightPlanPrompt(node, plans),
      model: FLIGHT_PLAN_MODEL,
      workingDir,
      tools: PLAN_TOOLS,
      timeoutMs: PLAN_TIMEOUT_MS,
      label: `pipeline-flightplan-${sanitize(node.id)}`,
    });
    const raw = readArtifact(workingDir, planArtifact(node.id));
    const parsed = raw ? parseFlightPlanContract(raw, node.id) : null;
    // Degrade gracefully: a bad/missing plan becomes a minimal contract from the
    // DAG node so one failed spawn doesn't sink the whole run. align still sees it.
    // The DAG node is authoritative for `phase` (the decomposer's structural call).
    plans.push({ ...(parsed ?? degradedContract(node)), phase: node.phase });
  }
  return plans;
}

export async function runAlign(
  prompt: string,
  dag: TaskDag,
  plans: FlightPlanContract[],
  workingDir: string,
  deps: PlanningDeps,
): Promise<Alignment> {
  await deps.spawn({
    prompt: alignPrompt(prompt, dag, plans),
    model: ALIGN_MODEL,
    workingDir,
    tools: PLAN_TOOLS,
    timeoutMs: PLAN_TIMEOUT_MS,
    label: 'pipeline-align',
  });
  const raw = readArtifact(workingDir, ALIGN_ARTIFACT);
  const alignment = raw ? parseAlignment(raw) : { conflicts: [], preflight: [] };
  // Deterministic backstop: two tasks must not own the same file. The composer
  // surfaces this regardless of the LLM judge so the operator catches it at the
  // preview gate (a coder can't safely co-author a file with a sibling).
  alignment.conflicts = [...detectScopeOverlaps(plans), ...alignment.conflicts];
  return alignment;
}

/**
 * Run the full planning sequence. Sets up a working dir (clone/worktree) unless
 * one is injected (test mode), tears it down after extracting artifacts. Returns
 * the aggregate PlanningResult — the orchestrator freezes it at the preview "go".
 */
export async function runPlanning(
  run: PipelineRun,
  target: PlanTarget,
  opts: Partial<PlanningDeps> & { revisionNote?: string | null } = {},
): Promise<PlanningResult> {
  const deps: PlanningDeps = { spawn: opts.spawn ?? defaultDeps().spawn, ...(opts.workingDir ? { workingDir: opts.workingDir } : {}) };
  const injected = !!deps.workingDir;
  let wd: git.WorkingDir | null = null;
  let workingDir: string;
  if (deps.workingDir) {
    workingDir = deps.workingDir;
  } else {
    wd = setupPlanningDir(run, target);
    workingDir = wd.path;
  }

  audit('pipeline.stage.advanced', 'pipeline.planning', { runId: run.id, stage: 'planning.decompose' });
  try {
    const dag = await runDecompose(target, workingDir, deps, opts.revisionNote ?? null);
    audit('pipeline.stage.advanced', 'pipeline.planning', {
      runId: run.id,
      stage: 'planning.flight_plans',
      tasks: dag.nodes.length,
    });
    const plans = await runFlightPlans(dag, workingDir, deps);
    audit('pipeline.stage.advanced', 'pipeline.planning', { runId: run.id, stage: 'planning.align' });
    const alignment = await runAlign(target.description, dag, plans, workingDir, deps);
    return { dag, plans, alignment };
  } finally {
    clearArtifacts(workingDir);
    // Only tear down a dir we created. An injected (test) dir is the caller's.
    if (!injected && wd) {
      try {
        wd.cleanup();
      } catch {
        /* swallow */
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function degradedContract(node: DagNode): FlightPlanContract {
  return {
    task_id: node.id,
    description: node.description,
    phase: node.phase,
    deps: node.deps,
    creates: [],
    modifies: node.target_paths,
    consumes: [],
    preflight: [],
    scope_boundary: [],
    acceptance: [],
  };
}

/**
 * Topological order so each flight-plan agent sees its dependencies' plans
 * before drafting. Kahn's algorithm; on a cycle (or dangling dep) the remaining
 * nodes are appended in original order — align flags the circular dependency.
 */
export function topoSort(dag: TaskDag): DagNode[] {
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  for (const n of dag.nodes) {
    indeg.set(n.id, n.deps.filter((d) => byId.has(d)).length);
  }
  const queue = dag.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: DagNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) out.push(node);
    for (const m of dag.nodes) {
      if (m.deps.includes(id)) {
        indeg.set(m.id, (indeg.get(m.id) ?? 1) - 1);
        if ((indeg.get(m.id) ?? 0) === 0) queue.push(m.id);
      }
    }
  }
  // Append any nodes left out by a cycle, in original order.
  for (const n of dag.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

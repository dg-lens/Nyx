/**
 * Pre-dispatch dependency-DAG compiler (shadow normalizer, deterministic).
 *
 * Given a task + its immediate [depends:] ancestors, build the dependency DAG:
 *  - nodes  = the task plus each ancestor it depends on (and, where known,
 *             each ancestor's own depends — one level out).
 *  - edges  = [from, to] where `from` depends on `to`.
 *  - topo_order via Kahn's algorithm; null on cycle (cycle nodes reported).
 *  - predicted_conflicts via TWO independent signals, unioned per task pair:
 *      1. file-set intersection of the two tasks' planned (create+modify) files,
 *         read from their recorded flight plans.
 *      2. `git merge-tree <baseSha> <a> <b>` when both tasks have a locatable
 *         commit — parsed for conflict markers as a second, content-aware signal.
 *
 * NO LLM. Fully deterministic and unit-tested. The merge-tree probe is
 * best-effort: any git failure (no commit, no merge-base, old git) contributes
 * zero conflicts rather than throwing.
 */

import { execSync } from 'node:child_process';

import type { ParsedTask } from '../types.js';
import { findCommitForTask } from './chain-context.js';
import { getLatestFlightPlan } from './db.js';
import type { ChainDag, FlightPlan } from './types.js';

/** Files a flight plan declares it will create or modify. */
function plannedFiles(plan: FlightPlan | null): Set<string> {
  if (!plan) return new Set();
  return new Set([...plan.files.create, ...plan.files.modify]);
}

/** Intersection of two tasks' planned file sets — signal 1. */
function fileSetConflict(a: FlightPlan | null, b: FlightPlan | null): string[] {
  const fa = plannedFiles(a);
  const fb = plannedFiles(b);
  const out: string[] = [];
  for (const f of fa) if (fb.has(f)) out.push(f);
  return out.sort();
}

/**
 * `git merge-tree` conflict probe — signal 2. Returns the files git reports as
 * conflicting when merging commit `a` and commit `b` over their merge-base.
 *
 * Uses the modern `--write-tree --name-only` form (git 2.38+) which prints the
 * conflicting paths on a non-zero exit; falls back to scanning the raw output
 * for classic `<<<<<<<` markers / `CONFLICT (` lines on older git. Any failure
 * yields [].
 */
function mergeTreeConflict(workingDir: string, shaA: string, shaB: string): string[] {
  // Find a merge base; without one, merge-tree's 3-way form can't run cleanly.
  let base: string | null = null;
  try {
    base = execSync(`git merge-base ${shaA} ${shaB}`, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    base = null;
  }

  // Preferred: structured, name-only output (git >= 2.38). On a conflict git
  // exits non-zero and prints a NUL/newline-separated conflict file list after
  // the tree OID line; we capture both stdout and that.
  try {
    const out = execSync(`git merge-tree --write-tree --name-only --merge-base=${base ?? shaA} ${shaA} ${shaB}`, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseMergeTreeNameOnly(out);
  } catch (err) {
    // Non-zero exit with captured stdout still carries the conflict list.
    const stdout = (err as { stdout?: Buffer | string } | null)?.stdout;
    if (stdout != null) {
      const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      const parsed = parseMergeTreeNameOnly(text);
      if (parsed.length > 0) return parsed;
    }
  }

  // Fallback: classic trivial-merge output scanned for CONFLICT lines.
  if (!base) return [];
  try {
    const out = execSync(`git merge-tree ${base} ${shaA} ${shaB}`, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseClassicMergeTree(out);
  } catch {
    return [];
  }
}

/**
 * Parse `git merge-tree --write-tree --name-only` output. Format on conflict:
 *   <oid-of-tree>
 *   <conflicted-path-1>
 *   <conflicted-path-2>
 *   ...
 * The first line is the tree OID; remaining non-empty lines are conflict paths.
 * On a clean merge git prints only the tree OID (no extra lines) — so we drop
 * the first line and return the rest.
 */
export function parseMergeTreeNameOnly(out: string): string[] {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  // git can NUL-separate the name-only list; split on NUL too.
  return [...new Set(lines.slice(1).flatMap((l) => l.split('\0')).filter((p) => p.trim().length > 0))].sort();
}

/**
 * Parse classic `git merge-tree <base> <a> <b>` output for conflict markers.
 * The classic format embeds `+<<<<<<< .our` and `CONFLICT` cues with a
 * preceding path header; we extract paths from `changed in both` blocks.
 */
export function parseClassicMergeTree(out: string): string[] {
  const files = new Set<string>();
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Classic conflict blocks open with "changed in both" then a "  base ..." /
    // "  our   ..." / "  their ..." triple naming the path.
    if (line.startsWith('changed in both')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = (lines[j] ?? '').match(/^\s+(?:our|their)\s+\S+\s+\S+\s+(.+)$/);
        if (m && m[1]) files.add(m[1].trim());
      }
    }
  }
  return [...files].sort();
}

/** Union of the two conflict signals for a task pair, de-duplicated + sorted. */
function combineConflicts(fileSet: string[], mergeTree: string[]): string[] {
  return [...new Set([...fileSet, ...mergeTree])].sort();
}

/**
 * Build the chain DAG for a task. Returns null when the task declares no
 * [depends:] (there is no chain to compile). Otherwise:
 *  - nodes/edges from task.depends[] + each ancestor's recorded depends_on_tasks.
 *  - topo_order via Kahn; cycle reported when the sort can't drain all nodes.
 *  - predicted_conflicts over every chained task PAIR with locatable plans/commits.
 */
export function buildChainDag(
  task: ParsedTask,
  ancestors: { task_id: string; plan: FlightPlan | null }[],
  workingDir: string,
): ChainDag | null {
  const deps = task.depends ?? [];
  if (deps.length === 0) return null;

  // ── nodes + edges ──
  const nodeSet = new Set<string>([task.id]);
  const edges: [string, string][] = [];
  const addEdge = (from: string, to: string): void => {
    nodeSet.add(from);
    nodeSet.add(to);
    if (!edges.some(([f, t]) => f === from && t === to)) edges.push([from, to]);
  };

  for (const dep of deps) addEdge(task.id, dep);

  // One level out: each ancestor's own declared deps (from its recorded plan).
  const planByTask = new Map<string, FlightPlan | null>();
  for (const a of ancestors) planByTask.set(a.task_id, a.plan);
  for (const a of ancestors) {
    const anc = a.plan;
    if (!anc) continue;
    for (const d of anc.depends_on_tasks) addEdge(a.task_id, d);
  }

  const nodes = [...nodeSet];
  const { order, cycle } = kahnTopoSort(nodes, edges);

  // ── predicted conflicts ──
  // Resolve a plan for each chained task: prefer the ancestor context, fall back
  // to a fresh getLatestFlightPlan lookup so the task itself + transitive nodes
  // are covered.
  const resolvePlan = (id: string): FlightPlan | null => {
    if (planByTask.has(id)) return planByTask.get(id) ?? null;
    const p = getLatestFlightPlan(id);
    planByTask.set(id, p);
    return p;
  };

  const predicted_conflicts: ChainDag['predicted_conflicts'] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const fileSet = fileSetConflict(resolvePlan(a), resolvePlan(b));
      const shaA = findCommitForTask(workingDir, a);
      const shaB = findCommitForTask(workingDir, b);
      const mergeTree = shaA && shaB ? mergeTreeConflict(workingDir, shaA, shaB) : [];
      const files = combineConflicts(fileSet, mergeTree);
      if (files.length > 0) predicted_conflicts.push({ between: [a, b], files });
    }
  }

  return {
    nodes,
    edges,
    topo_order: order,
    cycle,
    predicted_conflicts,
  };
}

/**
 * Kahn topological sort. Edge [from, to] means `from` depends on `to`, so `to`
 * must come BEFORE `from` in execution order. We sort dependencies-first:
 * a node is emittable once all nodes it depends on are already emitted.
 *
 * Returns { order, cycle: null } on success, or { order: null, cycle } with the
 * residual (un-orderable) nodes when a cycle blocks completion.
 */
export function kahnTopoSort(
  nodes: string[],
  edges: [string, string][],
): { order: string[] | null; cycle: string[] | null } {
  // outDegree[n] = number of unmet dependencies (edges n -> dep).
  const outDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> [nodes that depend on it]
  for (const n of nodes) {
    outDegree.set(n, 0);
    dependents.set(n, []);
  }
  for (const [from, to] of edges) {
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
    dependents.set(to, [...(dependents.get(to) ?? []), from]);
  }

  // Deterministic seed: nodes with no unmet deps, in input order.
  const ready = nodes.filter((n) => (outDegree.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const dep of dependents.get(n) ?? []) {
      const d = (outDegree.get(dep) ?? 0) - 1;
      outDegree.set(dep, d);
      if (d === 0) ready.push(dep);
    }
  }

  if (order.length === nodes.length) return { order, cycle: null };
  // Remaining nodes (out-degree never hit 0) form / feed the cycle.
  const cycle = nodes.filter((n) => !order.includes(n)).sort();
  return { order: null, cycle };
}

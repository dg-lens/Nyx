export type TaskType = 'code' | 'content' | 'analysis' | 'assistant' | 'pipeline';
export type Model = 'opus' | 'sonnet' | 'haiku';
export type Priority = 'high' | 'normal' | 'low';
export type GateStage = 'typecheck' | 'tests' | 'lint';

export interface ParsedTask {
  id: string;
  description: string;
  type: TaskType;
  model: Model;
  gates: GateStage[] | 'none';
  repo?: string;
  output?: string;
  /**
   * Tasks whose `[x]`-completion is required before this one becomes pickable.
   * Stored as an array even for the single-dep case so callers don't branch.
   * `[depends: A]` → `['A']`. `[depends: A, B, C]` → `['A','B','C']`.
   */
  depends?: string[];
  /**
   * v0.7: env vars this task needs at runtime. `[env: NAME1, NAME2]` declares
   * them; the preflight phase verifies each is present in the resolved
   * Bitwarden project before invoking Claude. Names only — never values.
   */
  envVars?: string[];
  /**
   * v0.7: artifacts (file paths relative to the working dir) the task must
   * produce. `[expects: path1, path2]` declares them. After the gate passes,
   * the expects verifier checks each exists; missing → task.expects.failed →
   * audit. Catches spec-divergence at end-of-task instead of at runtime.
   */
  expects?: string[];
  /**
   * v0.12: doc references to inject as REQUIRED CONTEXT at the top of the
   * spawned agent's prompt. Each element is a raw reference token such as
   * "T1 §3.1", "T4 2026-05-24-slug", or "playbook writing-nyx-task-specs".
   * At dispatch time, reading-resolver.ts resolves each to its file/section
   * content and prepends the block to the agent's prompt before the task header.
   */
  reading?: string[];
  priority: Priority;
  checked: boolean;
  rawLines: string[];
  startLine: number;
  endLine: number;
  invalidTags: Array<{ tag: string; raw: string }>;
  /**
   * Scheduling: a task is in exactly one bucket.
   *   - `slot`: fires daily at slot N (0..287). Stays in Active forever.
   *   - `everyStepSlots`: fires whenever current_slot % step === 0. Stays in Active forever.
   *   - neither: task is on the standing list — one-shot, eligible only when no
   *     slot-bound tasks fire this tick. Marked `[x]` and moved to Completed when done.
   */
  slot?: number;
  everyStepSlots?: number;
}

export type Scheduling =
  | { kind: 'slot'; slot: number }
  | { kind: 'every'; stepSlots: number }
  | { kind: 'standing' };

export function schedulingOf(t: ParsedTask): Scheduling {
  if (typeof t.slot === 'number') return { kind: 'slot', slot: t.slot };
  if (typeof t.everyStepSlots === 'number') return { kind: 'every', stepSlots: t.everyStepSlots };
  return { kind: 'standing' };
}

export interface GateResult {
  passed: boolean;
  stages: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    log: string;
  }>;
  failureLog: string;
}

export interface RunOutcome {
  taskId: string;
  status: 'completed' | 'failed' | 'skipped' | 'abandoned';
  durationMs: number;
  prUrl?: string;
  outputPath?: string;
  failureLog?: string;
  testsPassed?: number;
}

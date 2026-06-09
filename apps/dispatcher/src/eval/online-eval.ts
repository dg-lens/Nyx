/**
 * Sampled async online-eval (G-A, stage EVAL).
 *
 * Scores a configurable % of CLEAN terminal runs plus 100% of FLAGGED runs with
 * a cheap LLM-as-judge, persisting a 0..1 quality score to the off-chain
 * eval_scores table. Modeled on the wisdom-capture spawn: cheap model, restricted
 * tools, NON-FATAL, and strictly OFF the hot path — it runs on a cadence at the
 * tail of the tick (maybeOnlineEval), never inside a task's dispatch. A judge
 * timeout/crash/malformed-output is logged and skipped; it can NEVER fail a task
 * or block the queue.
 *
 * Anti-Klarna-trap rule, load-bearing: clean runs are sampled, but a run that hit
 * ANY flagged signal (halt, audit routing, stall, exit-124) is ALWAYS scored —
 * you never skip a known-bad run. The judge prompt forces CoT-before-verdict (the
 * one universally-positive judge technique) and decomposes the score into named
 * dimensions to cut self-preference bias.
 *
 * Stage note: this is the FOUNDATION. Per the research, online eval starts
 * OBSERVATION-ONLY (scores accumulate; nothing gates on them) until judge-vs-
 * operator agreement is measured. The drift monitor is the only consumer, and it
 * only DMs — it never blocks.
 */
import { spawn } from 'node:child_process';

import type { RunTree } from './run-tree.js';

/** A deterministic-ish hash of the correlation id, mapped to [0,1). Used so the
 * sampling decision is STABLE per run (the same run id always lands the same side
 * of the threshold) — re-ticking can't flip a run in/out of the sample, and the
 * eval_scores dedup is the backstop. Not crypto; just a stable spread. */
function stableUnitHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 → unsigned; divide by 2^32 for a stable value in [0,1).
  return (h >>> 0) / 4294967296;
}

/**
 * Should this run be scored? Flagged runs are ALWAYS scored (reason: 'flagged').
 * Clean terminal runs are scored when their stable hash falls under the sampling
 * rate (reason: 'sampled'). In-progress runs are never scored (no outcome yet).
 * PURE — the caller filters out already-scored ids before calling.
 */
export function shouldSampleRun(run: RunTree, sampleRate: number): { sample: boolean; reason: 'sampled' | 'flagged' } {
  if (run.outcome === 'in-progress') return { sample: false, reason: 'sampled' };
  if (run.flagged) return { sample: true, reason: 'flagged' };
  const rate = Math.min(1, Math.max(0, sampleRate));
  return { sample: stableUnitHash(run.correlationId) < rate, reason: 'sampled' };
}

/** Pick the runs to score this cadence: terminal, not-yet-scored, and either
 * flagged or under the sample rate. PURE; the caller supplies the dedup set. */
export function selectRunsToScore(
  runs: RunTree[],
  sampleRate: number,
  alreadyScored: Set<string>,
): Array<{ run: RunTree; reason: 'sampled' | 'flagged' }> {
  const out: Array<{ run: RunTree; reason: 'sampled' | 'flagged' }> = [];
  for (const run of runs) {
    if (alreadyScored.has(run.correlationId)) continue;
    const { sample, reason } = shouldSampleRun(run, sampleRate);
    if (sample) out.push({ run, reason });
  }
  return out;
}

/**
 * Build the judge prompt for one run tree. The judge sees the run's event
 * sequence (the trajectory) — NOT the source diff or stdout (those are PII /
 * off-by-default per the trace privacy rule). It scores the OUTCOME shape:
 * did the declared work reach a clean terminal state, or did it limp there via
 * audit rescue / halts / stalls.
 *
 * CoT-before-verdict is enforced by the output contract: reason first, then a
 * single JSON line. 3 named dimensions (decomposed scoring cuts self-preference).
 */
export function buildJudgePrompt(run: RunTree): string {
  const trajectory = run.events
    .map((e) => `${e.at}  ${e.event}`)
    .join('\n');
  return [
    '# Run-quality judge',
    '',
    'You are an EVALUATOR, not the agent that did the work. Below is the event',
    'trajectory of one autonomous run (the ordered audit events, no source code).',
    'Judge how GOOD the OUTCOME was on a 0.0–1.0 scale.',
    '',
    `Correlation id: ${run.correlationId}`,
    `Task type: ${run.taskType ?? 'unknown'}`,
    `Terminal outcome: ${run.outcome}`,
    '',
    '## Trajectory',
    '',
    trajectory,
    '',
    '## How to score (decompose, then combine)',
    '',
    'Reason step-by-step FIRST across these three dimensions, THEN emit the score:',
    '1. cleanliness — did it reach its terminal state directly, or limp there via',
    '   audit rescue, halts, stalls, retries, or escalations? Direct = high.',
    '2. completeness — does the event sequence show the declared work actually',
    '   finished (committed/pushed/delivered/output written) vs bailing early?',
    '3. cost-shape — was the run economical, or did it burn an anomalous amount',
    '   of turns/cost for its type? (Ignore if no cost was metered.)',
    '',
    'A clean direct completion scores high (≈0.8–1.0). A run that only succeeded',
    'after audit rescue or a halt scores mid (≈0.3–0.6). A failed/abandoned run',
    'scores low (≈0.0–0.3).',
    '',
    '## Output contract',
    '',
    'Write your step-by-step reasoning across the three dimensions, then end with',
    'EXACTLY ONE final line containing only this JSON (no fence, no prose after it):',
    '',
    '{"score": <0.0-1.0>, "rationale": "<one sentence>"}',
  ].join('\n');
}

export interface JudgeVerdict {
  score: number;
  rationale: string | null;
}

/**
 * Parse the judge's final-line JSON. The contract puts the JSON on the LAST
 * non-empty line (CoT reasoning precedes it), so scan from the bottom for the
 * first parseable `{...score...}` object. Returns null on any miss — the caller
 * then logs eval.online.skipped and moves on (never throws).
 */
export function parseJudgeVerdict(stdout: string): JudgeVerdict | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{') || !line.includes('score')) continue;
    try {
      const obj = JSON.parse(line) as { score?: unknown; rationale?: unknown };
      const score = typeof obj.score === 'number' && Number.isFinite(obj.score) ? obj.score : null;
      if (score == null) continue;
      const clamped = Math.min(1, Math.max(0, score));
      const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 500) : null;
      return { score: clamped, rationale };
    } catch {
      continue;
    }
  }
  return null;
}

export interface JudgeSpawnOptions {
  model: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Spawn the judge as a cheap, tool-less `claude -p` and return its parsed
 * verdict, or null on any failure (non-zero exit, timeout, unparseable output).
 * No tools are granted — the judge only reads the prompt and emits text, so it
 * needs no filesystem/MCP access (also closes the lethal-trifecta surface for an
 * evaluation spawn). NON-FATAL by contract: this never throws.
 */
export async function spawnJudge(run: RunTree, opts: JudgeSpawnOptions): Promise<JudgeVerdict | null> {
  const prompt = buildJudgePrompt(run);
  const args = ['-p', prompt, '--model', opts.model, '--allowed-tools', ''];
  return await new Promise<JudgeVerdict | null>((resolveVerdict) => {
    let stdout = '';
    let settled = false;
    const finish = (v: JudgeVerdict | null): void => {
      if (settled) return;
      settled = true;
      resolveVerdict(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', args, { env: opts.env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      finish(null);
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(parseJudgeVerdict(stdout));
    });
  });
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ParsedTask } from './types.js';

/**
 * Cheap, independent content-judge (P7 — the content-level verifier wave-1
 * named, sharpened by the LLM-as-judge bias research).
 *
 * A green gate proves the code compiled and the suite ran; it does NOT prove the
 * diff actually does what the task asked. This is a SECOND, independent signal:
 * a haiku Read/Grep-only spawn (the wisdom-capture spawn shape) reads the
 * committed diff and scores it 0-100 against the task's acceptance criteria,
 * emitting a structured PASS/FAIL with a confidence.
 *
 * Bias mitigations baked into the prompt (from arXiv 2604.23178 / 2604.22891):
 *   - CoT-before-verdict — the ONLY universally-positive judge strategy; the
 *     judge must reason in `analysis` BEFORE it commits to score/verdict.
 *   - 3-5 named dimensions (spec-conformance, correctness, completeness,
 *     no-regression) — decomposed scoring cuts self-preference ~31.5%; we stop
 *     at 4 (>5 dilutes).
 *   - same-family caveat — every Nyx spawn is Claude judging Claude. The judge
 *     is therefore ADVISORY: a FAIL flags for review, it never fails the task.
 *
 * Threshold: a verdict counts as a concern only when verdict==='FAIL' AND
 * confidence ≥ JUDGE_CONFIDENCE_THRESHOLD (the ~75/100 the spec calls for) — a
 * low-confidence FAIL is noise and is suppressed. Non-fatal end to end: a missing
 * file, a malformed envelope, or a spawn timeout all resolve to "no concern",
 * exactly like wisdom-capture skips.
 */

export const JUDGE_FILE = 'NYX_JUDGE.md';
export const JUDGE_CONFIDENCE_THRESHOLD = 75;

export type JudgeVerdict = 'PASS' | 'FAIL';

export interface JudgeDimension {
  name: string;
  score: number;
}

export interface ContentJudgement {
  verdict: JudgeVerdict;
  confidence: number;
  score: number;
  dimensions: JudgeDimension[];
  analysis: string;
  rationale: string;
}

interface JudgeMeta {
  verdict?: unknown;
  confidence?: unknown;
  score?: unknown;
  dimensions?: unknown;
  rationale?: unknown;
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function parseDimensions(v: unknown): JudgeDimension[] {
  if (!Array.isArray(v)) return [];
  const out: JudgeDimension[] = [];
  for (const d of v) {
    if (d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string') {
      out.push({ name: (d as { name: string }).name, score: clampScore((d as { score?: unknown }).score) });
    }
  }
  return out;
}

/**
 * Parse the judge's NYX_JUDGE.md: a ```json fence (verdict/confidence/score/
 * dimensions/rationale) followed by the CoT analysis prose. Mirrors the wisdom-
 * capture file shape so the spawn plumbing is identical. Returns null on any
 * absent/malformed input — the caller treats null as "no concern".
 */
export function parseJudgeFile(workingDir: string): ContentJudgement | null {
  const filePath = resolve(workingDir, JUDGE_FILE);
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseJudgeContent(raw);
}

export function parseJudgeContent(raw: string): ContentJudgement | null {
  const fence = /```json\n([\s\S]*?)\n```/m.exec(raw);
  if (!fence || !fence[1]) return null;
  let meta: JudgeMeta;
  try {
    meta = JSON.parse(fence[1]) as JudgeMeta;
  } catch {
    return null;
  }
  const verdictRaw = typeof meta.verdict === 'string' ? meta.verdict.toUpperCase() : '';
  if (verdictRaw !== 'PASS' && verdictRaw !== 'FAIL') return null;

  const analysis = raw.slice(fence.index + fence[0].length).trim();
  return {
    verdict: verdictRaw,
    confidence: clampScore(meta.confidence),
    score: clampScore(meta.score),
    dimensions: parseDimensions(meta.dimensions),
    analysis,
    rationale: typeof meta.rationale === 'string' ? meta.rationale : '',
  };
}

/**
 * Should this judgement be surfaced as a concern? A FAIL is only actionable when
 * the judge is confident enough — a low-confidence FAIL is noise (the same-family
 * advisory caveat). A PASS is never a concern.
 */
export function isJudgeConcern(j: ContentJudgement, threshold = JUDGE_CONFIDENCE_THRESHOLD): boolean {
  return j.verdict === 'FAIL' && j.confidence >= threshold;
}

/**
 * Build the judge prompt. The judge gets the task's acceptance criteria (the
 * description) + the gate stages it was held to, and is told to read the
 * committed diff itself (Read/Grep only — it cannot run anything, by design).
 * CoT-before-verdict + named dimensions are structural requirements of the
 * output schema, not suggestions.
 */
export function buildJudgePrompt(task: ParsedTask): string {
  const gates = task.gates === 'none' ? 'none' : task.gates.join(', ');
  return [
    '# Content Judge',
    '',
    `You are an INDEPENDENT reviewer scoring whether a code change did what its task asked.`,
    `The change already passed the automated gate (it compiles and tests run). Your job is`,
    `the thing the gate cannot check: does the diff actually SATISFY the task, or does it`,
    `merely compile?`,
    '',
    '## The task you are judging',
    '',
    `Task id: ${task.id}`,
    `Gate stages it was held to: ${gates}`,
    '',
    'Acceptance criteria (the task description):',
    '',
    task.description,
    '',
    '## What to do',
    '',
    '1. Inspect the change with `git diff` against the base (use Grep/Read to read the',
    '   touched files in full where the diff alone is ambiguous). You have READ-ONLY tools',
    '   — you cannot run code, install, or modify anything.',
    '2. Reason step by step BEFORE you decide. Write your reasoning in the prose section',
    '   AFTER the json fence — do not pre-commit to a verdict and rationalize backward.',
    '3. Score these four dimensions independently, 0-100 each:',
    '   - `spec-conformance` — does it do what the description asked (right behavior, right place)?',
    '   - `correctness` — is the logic sound; any obvious bug, off-by-one, wrong condition?',
    '   - `completeness` — are all parts of the ask covered, or only the easy ones?',
    '   - `no-regression` — does it avoid breaking adjacent behavior the task did not intend to touch?',
    '',
    '## Output',
    '',
    `Write \`${JUDGE_FILE}\` in the working directory with this exact structure:`,
    '',
    '````markdown',
    '```json',
    '{',
    '  "verdict": "PASS" | "FAIL",',
    '  "confidence": <0-100: how sure you are of the verdict>,',
    '  "score": <0-100: overall quality, roughly the mean of the dimensions>,',
    '  "dimensions": [',
    '    { "name": "spec-conformance", "score": <0-100> },',
    '    { "name": "correctness", "score": <0-100> },',
    '    { "name": "completeness", "score": <0-100> },',
    '    { "name": "no-regression", "score": <0-100> }',
    '  ],',
    '  "rationale": "<one sentence: the single most important reason for the verdict>"',
    '}',
    '```',
    '',
    'Your step-by-step analysis here (this is the CoT — write it AFTER the fence, and let it',
    'justify the scores above). Be concrete: cite file:line, name the missing requirement.',
    '````',
    '',
    'Verdict FAIL only when the change genuinely fails to satisfy the task — a missing',
    'requirement, a real bug, an off-spec implementation. Stylistic nits are not a FAIL.',
    'When in doubt and the change plausibly satisfies the task, PASS with a lower confidence.',
    '',
    `Write \`${JUDGE_FILE}\` now, then exit 0.`,
  ].join('\n');
}

/**
 * One-line summary for the audit payload + operator DM. Compact: verdict,
 * confidence, score, and the lowest-scoring dimension (the actionable one).
 */
export function summarizeJudgement(j: ContentJudgement): string {
  const weakest = [...j.dimensions].sort((a, b) => a.score - b.score)[0];
  const dim = weakest ? ` weakest=${weakest.name}:${weakest.score}` : '';
  return `${j.verdict} conf=${j.confidence} score=${j.score}${dim}${j.rationale ? ` — ${j.rationale}` : ''}`;
}

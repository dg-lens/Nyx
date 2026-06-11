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
 * working-tree diff (the judge runs BEFORE finalize commits) and scores it 0-100
 * against the task's acceptance criteria, emitting a structured PASS/FAIL with a
 * confidence.
 *
 * Bias mitigations baked into the prompt (from the LLM-as-judge bias literature):
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

/**
 * One discrete deliverable the spec asked for — a numbered/lettered part, an
 * `[expects:]` path, or a named invariant — paired with whether the diff/tree
 * actually delivered it. The absence-aware checklist (P-judge) lists every part
 * so a delivery that scores well on prose-dimensions can't hide a missing chunk.
 */
export interface JudgePart {
  name: string;
  present: boolean;
}

export interface ContentJudgement {
  verdict: JudgeVerdict;
  confidence: number;
  score: number;
  dimensions: JudgeDimension[];
  /**
   * The spec-deliverable checklist. Empty when the judge emitted no `parts`
   * array (backward compatible — older verdicts and malformed-parts envelopes
   * still parse). `partsPresent`/`partsTotal` are derived counts the audit
   * payload carries alongside the raw list.
   */
  parts: JudgePart[];
  partsPresent: number;
  partsTotal: number;
  analysis: string;
  rationale: string;
}

interface JudgeMeta {
  verdict?: unknown;
  confidence?: unknown;
  score?: unknown;
  dimensions?: unknown;
  parts?: unknown;
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
 * Parse the deliverable checklist. Each entry needs a string `name` and a
 * `present` flag (truthy/falsy coerced to boolean). A missing/non-array `parts`
 * field yields `[]` — the backward-compatible default for older verdicts that
 * predate the absence-aware checklist.
 */
function parseParts(v: unknown): JudgePart[] {
  if (!Array.isArray(v)) return [];
  const out: JudgePart[] = [];
  for (const p of v) {
    if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') {
      out.push({ name: (p as { name: string }).name, present: (p as { present?: unknown }).present === true });
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
  const parts = parseParts(meta.parts);
  return {
    verdict: verdictRaw,
    confidence: clampScore(meta.confidence),
    score: clampScore(meta.score),
    dimensions: parseDimensions(meta.dimensions),
    parts,
    partsPresent: parts.filter((p) => p.present).length,
    partsTotal: parts.length,
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
 * description) + the gate stages it was held to, and is told to read the diff
 * itself (Read/Grep only — it cannot run anything, by design). The spawn runs
 * pre-commit, so the diff lives in the WORKING TREE (`git diff` against the base
 * branch, not a committed range). CoT-before-verdict + named dimensions are
 * structural requirements of the output schema, not suggestions.
 *
 * Absence-aware (P-judge): BEFORE the dimension scoring the judge first enumerates
 * the spec's discrete deliverables as a checklist, verifies each against the tree,
 * and ties `spec-conformance` to the FRACTION PRESENT — so a delivery that omits a
 * declared part cannot earn a high score by polishing the parts it did ship. When
 * the task declares `[expects:]` paths, they seed the checklist; absent that, the
 * judge derives the parts from the spec text alone (the builder never assumes the
 * paths exist — `task.expects` is optional and may be undefined).
 */
export function buildJudgePrompt(task: ParsedTask): string {
  const gates = task.gates === 'none' ? 'none' : task.gates.join(', ');
  const expectsLines =
    task.expects && task.expects.length > 0
      ? [
          '',
          'Declared `[expects:]` artifacts (each is a discrete deliverable — every one MUST',
          'appear in the checklist below, marked present only if it actually exists in the tree):',
          '',
          ...task.expects.map((p) => `  - ${p}`),
        ]
      : [];
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
    ...expectsLines,
    '',
    '## What to do',
    '',
    '1. Inspect the change with `git diff` against the base (use Grep/Read to read the',
    '   touched files in full where the diff alone is ambiguous). You have READ-ONLY tools',
    '   — you cannot run code, install, or modify anything.',
    '2. Reason step by step BEFORE you decide. Write your reasoning in the prose section',
    '   AFTER the json fence — do not pre-commit to a verdict and rationalize backward.',
    '3. BEFORE scoring the dimensions, build a DELIVERABLES CHECKLIST. Enumerate the spec\'s',
    '   discrete deliverables: numbered/lettered parts, each declared `[expects:]` path above',
    '   (if any), and any named invariants the spec calls out. For EACH deliverable, verify it',
    '   against the actual diff/tree and mark it present (true) or absent (false). A part the',
    '   spec asked for but the tree does not contain is `present: false` — do not mark a part',
    '   present on intent alone.',
    '4. Score these four dimensions independently, 0-100 each:',
    '   - `spec-conformance` — anchor this to the checklist: it is the FRACTION of deliverables',
    '     marked present (parts_present / parts_total × 100). Absent parts contribute 0 — so a',
    '     delivery missing 2 of 5 parts cannot score above 60 on spec-conformance, no matter how',
    '     well the 3 present parts are implemented.',
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
    '    { "name": "spec-conformance", "score": <0-100: the fraction-present from the checklist> },',
    '    { "name": "correctness", "score": <0-100> },',
    '    { "name": "completeness", "score": <0-100> },',
    '    { "name": "no-regression", "score": <0-100> }',
    '  ],',
    '  "parts": [',
    '    { "name": "<a discrete deliverable from the spec>", "present": true | false }',
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
 * confidence, score, the deliverable-checklist ratio (when present), and the
 * lowest-scoring dimension (the actionable one).
 */
export function summarizeJudgement(j: ContentJudgement): string {
  const weakest = [...j.dimensions].sort((a, b) => a.score - b.score)[0];
  const dim = weakest ? ` weakest=${weakest.name}:${weakest.score}` : '';
  const parts = j.partsTotal > 0 ? ` parts=${j.partsPresent}/${j.partsTotal}` : '';
  return `${j.verdict} conf=${j.confidence} score=${j.score}${parts}${dim}${j.rationale ? ` — ${j.rationale}` : ''}`;
}

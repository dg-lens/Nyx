import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { GateStage, Model, ParsedTask, Priority, TaskType } from './types.js';
import { classOf, type TaskClass } from './concurrency.js';
import { config } from './config.js';
import { isValidRepoTag } from './pipeline/target.js';

// Matches only the OPENER of a tag: `[name:` plus any leading whitespace.
// The value is then scanned manually with bracket-depth tracking so a path
// containing a Next.js dynamic-route segment (`[slug]`, `[[...catchall]]`)
// is captured whole instead of being truncated at the first inner `]`.
const TAG_OPEN_RE = /\[([a-z]+):\s*/g;
const HEADER_ACTIVE = /^##\s+Active Tasks\s*$/i;
const HEADER_COMPLETED = /^##\s+Completed\s*$/i;
const TASK_LINE_RE = /^- \[( |x|X)\]\s+([A-Z][A-Z0-9-]+)\s+[—-]\s+(.+?)\s*$/;

const VALID_TYPES: TaskType[] = ['code', 'content', 'analysis', 'assistant', 'pipeline'];
const VALID_MODELS: Model[] = ['opus', 'sonnet', 'haiku'];
const VALID_GATES: GateStage[] = ['typecheck', 'tests', 'lint'];
const VALID_PRIORITIES: Priority[] = ['high', 'normal', 'low'];

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export const MINUTES_PER_SLOT = 5;
export const SLOTS_PER_HOUR = 60 / MINUTES_PER_SLOT;
export const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR;

export interface QueueFile {
  raw: string;
  lines: string[];
  active: ParsedTask[];
  completed: ParsedTask[];
}

// ─── Slot math ───────────────────────────────────────────────────────────────

/** Slot index for a given Date, in local time. 0 = 00:00, 287 = 23:55. */
export function slotOf(d: Date = new Date()): number {
  return d.getHours() * SLOTS_PER_HOUR + Math.floor(d.getMinutes() / MINUTES_PER_SLOT);
}

/**
 * Monotonic slot index since the Unix epoch, anchored to the local calendar day
 * so `[every:]` cadences survive midnight wrap and multi-day periods work.
 * globalSlot = (local days since epoch) * SLOTS_PER_DAY + slotOf(d). Because
 * SLOTS_PER_DAY divides every hour/minute step, intra-day cadence (`every: 3h`)
 * is unchanged, while `every: 2d` only matches every other midnight.
 */
export function globalSlotOf(d: Date = new Date()): number {
  const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.floor(localMidnight.getTime() / (SLOTS_PER_DAY * MINUTES_PER_SLOT * 60_000));
  return days * SLOTS_PER_DAY + slotOf(d);
}

/** Wall-clock "HH:MM" for a slot index. */
export function slotToTime(slot: number): string {
  const h = Math.floor(slot / SLOTS_PER_HOUR);
  const m = (slot % SLOTS_PER_HOUR) * MINUTES_PER_SLOT;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Wall-clock window [start, end) for the slot containing `d`. */
export function slotWindow(d: Date = new Date()): { slot: number; start: Date; end: Date } {
  const slot = slotOf(d);
  const start = new Date(d);
  start.setHours(Math.floor(slot / SLOTS_PER_HOUR), (slot % SLOTS_PER_HOUR) * MINUTES_PER_SLOT, 0, 0);
  const end = new Date(start.getTime() + MINUTES_PER_SLOT * 60_000);
  return { slot, start, end };
}

// ─── Schedule parsing ────────────────────────────────────────────────────────

function parseSlot(raw: string): { value: number; valid: true } | { valid: false } {
  // Anchor the whole string so trailing garbage is rejected instead of silently
  // truncated by parseInt — `12abc`, `1e2`, `12.9` are typos, not slot 12/1/12.
  // Matches the strict `^…$` anchoring already used in parseEveryStep.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0 || n >= SLOTS_PER_DAY) return { valid: false };
  return { value: n, valid: true };
}

/**
 * Parse `[every: …]`. Accepts:
 *   - "5m" / "15m" / "30m" — minute-based, must be a positive multiple of 5
 *   - "1h" / "2h" / "3h" / "6h" / "12h" / … — hour-based
 *   - "1d" / "Xd" — day-based (Xd = X * 288 slots)
 * Returns a step expressed in slots, or null for any malformed input.
 */
export function parseEveryStep(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  const unit = (m[2] ?? '').toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'm') {
    if (n % MINUTES_PER_SLOT !== 0) return null;
    return n / MINUTES_PER_SLOT;
  }
  if (unit === 'h') return n * SLOTS_PER_HOUR;
  if (unit === 'd') return n * SLOTS_PER_DAY;
  return null;
}

// ─── Tag parsing ─────────────────────────────────────────────────────────────

function parseTags(blob: string): { tags: Record<string, string>; duplicates: string[] } {
  const tags: Record<string, string> = {};
  const duplicates: string[] = [];
  let m: RegExpExecArray | null;
  TAG_OPEN_RE.lastIndex = 0;
  while ((m = TAG_OPEN_RE.exec(blob))) {
    const name = m[1];
    if (!name) continue;
    // Scan from just past the opener, tracking nested-bracket depth so the
    // tag only closes on a `]` at depth 0. Inner pairs from dynamic-route
    // segments (`[slug]`, `[[...catchall]]`) keep the value intact.
    let depth = 0;
    let value = '';
    let i = TAG_OPEN_RE.lastIndex;
    let closed = false;
    for (; i < blob.length; i++) {
      const ch = blob[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        if (depth === 0) { closed = true; break; }
        depth--;
      }
      value += ch;
    }
    if (!closed) continue;
    if (value.trim()) {
      // A tag key appearing twice is ambiguous: the last occurrence would
      // silently win (potentially routing to the wrong repo/type). Record the
      // collision so readQueue can surface it as an invalidTag rather than
      // overwrite without warning. First-seen value is retained for context.
      if (Object.prototype.hasOwnProperty.call(tags, name)) {
        if (!duplicates.includes(name)) duplicates.push(name);
      } else {
        tags[name] = value.trim();
      }
    }
    // Resume scanning after the closing `]` so we don't re-enter the value.
    TAG_OPEN_RE.lastIndex = i + 1;
  }
  return { tags, duplicates };
}

function defaultsForType(type: TaskType): { gates: GateStage[] | 'none'; model: Model } {
  // Operator-overridable default model per type (Settings tab -> settings.json).
  const pref = config.settings.dispatcher.defaultModels[type];
  const m: Model | undefined = (VALID_MODELS as string[]).includes(pref ?? '') ? (pref as Model) : undefined;
  if (type === 'code') return { gates: ['typecheck', 'tests'], model: m ?? 'sonnet' };
  if (type === 'analysis') return { gates: 'none', model: m ?? 'opus' };
  if (type === 'content') return { gates: 'none', model: m ?? 'sonnet' };
  // pipeline: the orchestrator runs its own per-stage gates internally and picks
  // per-stage models (planning/composer opus-class, coders sonnet), so the
  // task-level gate is 'none' and the model is a nominal default.
  if (type === 'pipeline') return { gates: 'none', model: m ?? 'opus' };
  return { gates: 'none', model: m ?? 'haiku' };
}

interface ParseResult<T> { value: T; valid: boolean }

function parseType(raw: string | undefined): ParseResult<TaskType> {
  if (raw == null) return { value: 'code', valid: true };
  const v = raw.toLowerCase();
  if ((VALID_TYPES as string[]).includes(v)) return { value: v as TaskType, valid: true };
  return { value: 'code', valid: false };
}

function parseModel(raw: string | undefined, fallback: Model): ParseResult<Model> {
  if (raw == null) return { value: fallback, valid: true };
  const v = raw.toLowerCase();
  if ((VALID_MODELS as string[]).includes(v)) return { value: v as Model, valid: true };
  return { value: fallback, valid: false };
}

function parsePriority(raw: string | undefined): ParseResult<Priority> {
  if (raw == null) return { value: 'normal', valid: true };
  const v = raw.toLowerCase();
  if ((VALID_PRIORITIES as string[]).includes(v)) return { value: v as Priority, valid: true };
  return { value: 'normal', valid: false };
}

function parseGate(raw: string | undefined, fallback: GateStage[] | 'none'): ParseResult<GateStage[] | 'none'> {
  if (raw == null) return { value: fallback, valid: true };
  const v = raw.trim().toLowerCase();
  if (v === 'none') return { value: 'none', valid: true };
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  const out: GateStage[] = [];
  let allValid = true;
  for (const p of parts) {
    if ((VALID_GATES as string[]).includes(p)) out.push(p as GateStage);
    else allValid = false;
  }
  if (out.length === 0) return { value: fallback, valid: false };
  return { value: out, valid: allValid };
}

// ─── Queue I/O ───────────────────────────────────────────────────────────────

export function readQueue(path: string): QueueFile {
  // A missing queue file is an empty queue, not a crash. The daemon can be started
  // (e.g. `brew services start`) before `nyx bootstrap` seeds nyx.md; an unguarded
  // read would throw ENOENT, bubble to the top-level catch, and log a misleading
  // task.failed. Treat absent as idle instead.
  if (!existsSync(path)) return { raw: '', lines: [], active: [], completed: [] };
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');

  let section: 'none' | 'active' | 'completed' = 'none';
  let inHtmlComment = false;
  let inFence = false;
  const active: ParsedTask[] = [];
  const completed: ParsedTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false;
      continue;
    }
    if (line.trim().startsWith('<!--')) {
      if (!line.includes('-->')) inHtmlComment = true;
      continue;
    }

    // A fenced code block (```) may hold example task lines (CLAUDE.md DO/DON'T
    // blocks). Don't parse those as real tasks — toggle and skip while inside.
    if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;

    if (HEADER_ACTIVE.test(line)) { section = 'active'; continue; }
    if (HEADER_COMPLETED.test(line)) { section = 'completed'; continue; }
    if (/^##\s+/.test(line)) { section = 'none'; continue; }

    const m = line.match(TASK_LINE_RE);
    if (!m || section === 'none') continue;
    const checked = m[1] !== ' ';
    const id = m[2] ?? '';
    const description = (m[3] ?? '').trim();
    if (!id) continue;

    const startLine = i;
    const blobParts: string[] = [line];
    let j = i + 1;
    let bodyInFence = false;
    while (j < lines.length) {
      const next = lines[j] ?? '';
      // Inside a fenced block, example task lines / headers are body content,
      // not real task boundaries — capture them and only break once the fence
      // closes. This keeps the parent blob (and its trailing tags) intact.
      if (next.trim().startsWith('```')) {
        bodyInFence = !bodyInFence;
        blobParts.push(next);
        j++;
        continue;
      }
      if (!bodyInFence) {
        if (next.match(TASK_LINE_RE)) break;
        if (HEADER_ACTIVE.test(next) || HEADER_COMPLETED.test(next) || /^##\s+/.test(next)) break;
      }
      blobParts.push(next);
      if (!bodyInFence && next.trim() === '' && j + 1 < lines.length) {
        const lookahead = lines[j + 1] ?? '';
        if (lookahead.match(TASK_LINE_RE) || /^##\s+/.test(lookahead)) break;
      }
      j++;
    }
    const endLine = j - 1;
    const blob = blobParts.join(' ');
    const { tags, duplicates } = parseTags(blob);

    const invalidTags: ParsedTask['invalidTags'] = [];
    for (const dup of duplicates) {
      invalidTags.push({ tag: dup, raw: `duplicate tag: ${tags[dup] ?? ''}` });
    }
    const t = parseType(tags['type']);
    if (!t.valid) invalidTags.push({ tag: 'type', raw: tags['type'] ?? '' });
    const defaults = defaultsForType(t.value);

    const mdl = parseModel(tags['model'], defaults.model);
    if (!mdl.valid) invalidTags.push({ tag: 'model', raw: tags['model'] ?? '' });

    const g = parseGate(tags['gate'], defaults.gates);
    if (!g.valid) invalidTags.push({ tag: 'gate', raw: tags['gate'] ?? '' });

    const pr = parsePriority(tags['priority']);
    if (!pr.valid) invalidTags.push({ tag: 'priority', raw: tags['priority'] ?? '' });

    // Scheduling tags. A task can have [slot:] XOR [every:], never both.
    let slot: number | undefined;
    let everyStepSlots: number | undefined;
    if (tags['slot'] != null) {
      const s = parseSlot(tags['slot']);
      if (s.valid) slot = s.value;
      else invalidTags.push({ tag: 'slot', raw: tags['slot'] });
    }
    if (tags['every'] != null) {
      const step = parseEveryStep(tags['every']);
      if (step != null) everyStepSlots = step;
      else invalidTags.push({ tag: 'every', raw: tags['every'] });
    }
    if (slot != null && everyStepSlots != null) {
      invalidTags.push({ tag: 'slot+every', raw: `${tags['slot']} / ${tags['every']}` });
    }

    // Legacy 0.2 tags — be loud, not silent.
    if (tags['recurring'] != null) invalidTags.push({ tag: 'recurring', raw: tags['recurring'] });
    if (tags['at'] != null) invalidTags.push({ tag: 'at', raw: tags['at'] });

    // Security (C2): an unvalidated [repo:] value is interpolated into `git clone`
    // for code/analysis tasks (git-ops.cloneExternalRepo). Reject anything that
    // isn't an `owner/name` repo or a greenfield keyword so a value carrying shell
    // metacharacters can never reach the clone command. A flagged task has
    // invalidTags.length > 0 and is therefore never returned by pickNextTask —
    // it surfaces to the operator via tasksWithInvalidTags instead of executing.
    if (tags['repo'] != null && !isValidRepoTag(tags['repo'])) {
      invalidTags.push({ tag: 'repo', raw: tags['repo'] });
    }

    const task: ParsedTask = {
      id,
      description,
      type: t.value,
      model: mdl.value,
      gates: g.value,
      priority: pr.value,
      checked,
      rawLines: blobParts,
      startLine,
      endLine,
      invalidTags,
      ...(tags['repo'] ? { repo: tags['repo'] } : {}),
      ...(tags['output'] ? { output: tags['output'] } : {}),
      // v0.6.4: split comma-separated deps. `[depends: A, B, C]` → ['A','B','C'].
      // Always store as array (even single dep) so the picker doesn't branch on shape.
      ...(tags['depends']
        ? { depends: tags['depends'].split(',').map(s => s.trim()).filter(Boolean) }
        : {}),
      // v0.7: explicit env-var declaration. `[env: NAME1, NAME2]` lists env vars
      // the task needs. The preflight check (see cli/run-once.ts) verifies each
      // is present in the bw-project's secrets BEFORE invoking Claude. Catches
      // misconfiguration at dispatch time instead of mid-Claude or post-gate.
      ...(tags['env']
        ? { envVars: tags['env'].split(',').map(s => s.trim()).filter(Boolean) }
        : {}),
      // v0.7: declare artifacts the task must produce. `[expects: path1, path2]`
      // is verified after the gate passes. Catches spec-divergence at task end
      // (e.g. EMP-002 silently writing the wrong filename) instead of at runtime.
      ...(tags['expects']
        ? { expects: tags['expects'].split(',').map(s => s.trim()).filter(Boolean) }
        : {}),
      // v0.12: doc references resolved at dispatch time and injected as a
      // REQUIRED CONTEXT block at the top of the agent's prompt. Raw tokens
      // (e.g. "T1 §3.1", "T4 slug") are stored as-is; reading-resolver.ts
      // parses and resolves them during buildPrompt() and preflight.
      ...(tags['reading']
        ? { reading: tags['reading'].split(',').map(s => s.trim()).filter(Boolean) }
        : {}),
      ...(slot != null ? { slot } : {}),
      ...(everyStepSlots != null ? { everyStepSlots } : {}),
    };
    (section === 'active' ? active : completed).push(task);
    i = endLine;
  }

  return { raw, lines, active, completed };
}

// ─── Picker ──────────────────────────────────────────────────────────────────

export interface PickerInput {
  /** Current time (defaults to now). */
  now?: Date;
  /** Task IDs that already fired in the current slot's window (from audit). */
  firedInSlot?: Set<string>;
  /** Task IDs already deferred or running this tick. */
  skipThisTick?: Set<string>;
  /**
   * Type-aware concurrency (Track 3): narrow candidates to one class. The ISO
   * refill loop passes `'iso'` (analysis/assistant/content); the single-GIT pick
   * passes `'git'` (code/pipeline). Omitted → all classes (legacy behavior).
   */
  classFilter?: TaskClass;
}

/**
 * Two-phase pick:
 *   1. Slot-bound tasks (explicit `[slot: N]` matching, or `[every: K]` where
 *      `globalSlot % K === 0` — globalSlot is the monotonic since-epoch index so
 *      multi-day cadences hold). Skipped if already fired in this slot's window
 *      or already attempted this tick.
 *   2. If no slot-bound candidates → standing list (no `[slot:]`, no `[every:]`).
 *
 * Within each phase, the usual filters apply (no `[FAILED]`, no invalid tags,
 * dependencies satisfied), then sort by priority then by file order.
 */
export function pickNextTask(q: QueueFile, input: PickerInput = {}): ParsedTask | null {
  const now = input.now ?? new Date();
  const slot = slotOf(now);
  const globalSlot = globalSlotOf(now);
  const fired = input.firedInSlot ?? new Set<string>();
  const skipped = input.skipThisTick ?? new Set<string>();

  const completedIds = new Set([
    ...q.completed.map(t => t.id),
    ...q.active.filter(t => t.checked).map(t => t.id),
  ]);

  const classFilter = input.classFilter;
  const baseFilter = (t: ParsedTask) =>
    !t.checked
    && !t.description.startsWith('[FAILED]')
    && t.invalidTags.length === 0
    && !skipped.has(t.id)
    && (classFilter == null || classOf(t.type) === classFilter)
    && (!t.depends || t.depends.every(d => completedIds.has(d)));

  const slotMatches = (t: ParsedTask): boolean => {
    if (t.slot != null) return t.slot === slot;
    // Cadence is computed against the monotonic global slot, not the within-day
    // index, so multi-day periods (`every: 2d`) and any non-divisor step measure
    // a true elapsed gap instead of re-anchoring at every local midnight.
    if (t.everyStepSlots != null) return globalSlot % t.everyStepSlots === 0;
    return false;
  };

  // Phase 1: slot-bound, not yet fired this slot.
  const slotCandidates = q.active.filter(t => baseFilter(t) && slotMatches(t) && !fired.has(t.id));
  if (slotCandidates.length > 0) {
    slotCandidates.sort((a, b) => {
      const dp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (dp !== 0) return dp;
      return a.startLine - b.startLine;
    });
    return slotCandidates[0] ?? null;
  }

  // Phase 2: standing list.
  const standing = q.active.filter(
    t => baseFilter(t) && t.slot == null && t.everyStepSlots == null,
  );
  if (standing.length === 0) return null;
  standing.sort((a, b) => {
    const dp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (dp !== 0) return dp;
    return a.startLine - b.startLine;
  });
  return standing[0] ?? null;
}

export function tasksWithInvalidTags(q: QueueFile): ParsedTask[] {
  return q.active.filter(t => !t.checked && t.invalidTags.length > 0);
}

// ─── Mutation helpers ────────────────────────────────────────────────────────

interface MarkOptions {
  durationMs: number;
  testsPassed?: number;
  prUrl?: string;
  outputPath?: string;
  failed?: boolean;
  failureSummary?: string;
}

function formatCompletionTags(opts: MarkOptions): string {
  const at = new Date().toISOString();
  const mins = Math.max(1, Math.round(opts.durationMs / 60_000));
  const parts = [`[completed: ${at}]`, `[duration: ${mins}m]`];
  if (typeof opts.testsPassed === 'number') parts.push(`[tests: ${opts.testsPassed} passed]`);
  if (opts.prUrl) parts.push(`[pr: ${opts.prUrl}]`);
  if (opts.outputPath) parts.push(`[output: ${opts.outputPath}]`);
  return parts.join(' ');
}

export function writeQueueAtomically(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function buildModifiedHead(oldHead: string, failed: boolean): string {
  const checked = oldHead.replace(/^- \[ \]/, '- [x]');
  if (!failed) return checked;
  return checked.replace(
    /^(- \[x\]\s+[A-Z][A-Z0-9-]+\s+[—-]\s+)(?!\[FAILED\])/,
    '$1[FAILED] ',
  );
}

function skipHeaderPreamble(arr: string[], from: number): number {
  let i = from;
  let inComment = false;
  while (i < arr.length) {
    const line = arr[i] ?? '';
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      i++;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') { i++; continue; }
    if (trimmed.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Move a STANDING task from Active to Completed. Never call this for slot-bound
 * tasks — they're recurring rules and stay in Active forever; their completion
 * record lives in the audit DB only.
 */
export function markTaskCompleted(path: string, taskId: string, opts: MarkOptions): void {
  const q = readQueue(path);
  const t = q.active.find(x => x.id === taskId);
  if (!t) return;

  const oldHead = q.lines[t.startLine] ?? '';
  const newHead = buildModifiedHead(oldHead, opts.failed === true);
  const continuation = q.lines.slice(t.startLine + 1, t.endLine + 1);
  const completionLine = `      ${formatCompletionTags(opts)}`;
  const fullBlock = [newHead, ...continuation, completionLine];

  const withActiveRemoved = [
    ...q.lines.slice(0, t.startLine),
    ...q.lines.slice(t.endLine + 1),
  ];

  const completedIdx = withActiveRemoved.findIndex(l => HEADER_COMPLETED.test(l));

  let result: string[];
  if (completedIdx === -1) {
    const tail = withActiveRemoved.length > 0 && withActiveRemoved[withActiveRemoved.length - 1] !== ''
      ? ['']
      : [];
    result = [...withActiveRemoved, ...tail, '## Completed', '', ...fullBlock];
  } else {
    const insertAt = skipHeaderPreamble(withActiveRemoved, completedIdx + 1);
    result = [
      ...withActiveRemoved.slice(0, insertAt),
      ...fullBlock,
      ...withActiveRemoved.slice(insertAt),
    ];
  }

  writeQueueAtomically(path, result.join('\n'));
}

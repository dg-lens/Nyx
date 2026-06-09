/**
 * Operator settings — the desktop Settings tab writes Data/settings.json; the
 * dispatcher reads it here. Absent file or any malformed field falls back to
 * defaults, so a missing/partial settings.json never changes behavior.
 *
 * NAME / OPERATOR_NAME live in Data/.env (the scaffolding contract), not here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The four notification categories every typed notifier event maps to. Drives
 * both per-category delivery policy (Workflow mode) and Pushover priority.
 */
export type NotificationCategory = 'action-required' | 'failure' | 'delivery' | 'status';

/**
 * Per-category delivery policy:
 * - `always`    — 24/7, ignores Workflow state.
 * - `workflow`  — deliver only while Workflow is active (in-schedule OR a live override).
 * - `workhours` — deliver only inside the scheduled window; a manual override does NOT enable it.
 * - `digest`    — never interrupt; batched into the off-hours "what you missed" summary (N4).
 * - `off`       — never delivered.
 */
export type CategoryPolicy = 'always' | 'workflow' | 'workhours' | 'digest' | 'off';

/** A single working-window for one weekday. Empty `start`/`end` (== '') means no window that day. */
export interface WorkflowDayWindow {
  start: string;
  end: string;
}

export interface NotificationsSettings {
  channels: {
    slack: boolean;
    pushover: { enabled: boolean };
  };
  workflow: {
    schedule: {
      // Keyed by lowercase weekday (sun..sat). A missing/empty window = off that day.
      mon: WorkflowDayWindow;
      tue: WorkflowDayWindow;
      wed: WorkflowDayWindow;
      thu: WorkflowDayWindow;
      fri: WorkflowDayWindow;
      sat: WorkflowDayWindow;
      sun: WorkflowDayWindow;
      timezone: string;
    };
    manualOverride: {
      active: boolean;
      // ISO-8601 instant after which the override self-expires. null = no override armed.
      expiresAt: string | null;
    };
  };
  categories: Record<NotificationCategory, CategoryPolicy>;
}

export interface NyxSettings {
  pipeline: {
    concurrentCap: number;
    slackNotifications: boolean;
    autoMerge: boolean;
    reviewStrictness: 'lenient' | 'normal' | 'strict';
  };
  dispatcher: {
    maxChainDepth: number;
    taskTimeoutMs: number;
    // Type-aware concurrency (Track 3):
    // 'own'    = the two-class model (NEW DEFAULT). GIT-class {code,pipeline}
    //            single-flight under the git lock; ISO-class
    //            {analysis,assistant,content} run concurrently up to
    //            maxConcurrentIso, alongside the one GIT task (within a tick).
    // 'global' = conservative single-tenant rollback: skip ALL spawning this tick
    //            if ANY claude CLI is live (incl. Iris/foreign). Reproduces the
    //            legacy serialize-everything behavior with no code revert.
    // 'off'    = no gating beyond the GIT single-flight lock; ISO unbounded up to
    //            maxConcurrentIso, rely on the dispatch lockfile for ticks.
    concurrencyGuard: 'global' | 'own' | 'off';
    // ISO-pool size one tick fills + drains (clamp [1,6]). The aggregate
    // live-spawn ceiling across both classes (clamp [1,12]) — a coder-heavy
    // pipeline phase shrinks the effective ISO cap so the Max-plan quota holds.
    maxConcurrentIso: number;
    maxConcurrentClaude: number;
    defaultModels: Record<string, string>;
  };
  plugins: { disabled: string[] };
  updates: {
    // check = dispatcher polls origin/main once a day and notifies when the
    // installed keg is behind. autoApply = also run 'nyx update' automatically
    // (off by default — auto-replacing running code is opt-in).
    check: boolean;
    autoApply: boolean;
  };
  notifications: NotificationsSettings;
}

export const SETTINGS_DEFAULTS: NyxSettings = {
  pipeline: { concurrentCap: 4, slackNotifications: true, autoMerge: false, reviewStrictness: 'normal' },
  dispatcher: {
    maxChainDepth: 2,
    taskTimeoutMs: 30 * 60_000,
    concurrencyGuard: 'own',
    maxConcurrentIso: 2,
    maxConcurrentClaude: 4,
    defaultModels: { code: 'sonnet', analysis: 'opus', content: 'sonnet', assistant: 'haiku', pipeline: 'opus' },
  },
  plugins: { disabled: [] },
  updates: { check: true, autoApply: false },
  notifications: {
    // Slack on, Pushover off by default → with no settings.json present, behavior
    // is exactly today's (Slack-only). Pushover opts in via settings + creds.
    channels: { slack: true, pushover: { enabled: false } },
    workflow: {
      // No working windows defined out of the box. With every day empty, Workflow
      // is inactive unless a manual override is armed — so 'workflow'/'workhours'
      // categories stay quiet until the operator sets a schedule. The categories
      // are still wired; the operator opts into scheduling via the desktop (N3).
      schedule: {
        mon: { start: '', end: '' },
        tue: { start: '', end: '' },
        wed: { start: '', end: '' },
        thu: { start: '', end: '' },
        fri: { start: '', end: '' },
        sat: { start: '', end: '' },
        sun: { start: '', end: '' },
        timezone: 'UTC',
      },
      manualOverride: { active: false, expiresAt: null },
    },
    categories: {
      'action-required': 'workflow',
      failure: 'workflow',
      delivery: 'workflow',
      status: 'digest',
    },
  },
};

/**
 * Clamp a hand-edited numeric setting to [min, max], falling back to `fallback`
 * for non-finite values (NaN, Infinity) or non-numbers. settings.json is a plain
 * file an operator can edit directly and JSON.parse accepts any number, so a 0 or
 * negative taskTimeoutMs/concurrentCap would otherwise disable every spawn or
 * stall dispatch. Bounds mirror the desktop Steppers in SettingsView.swift.
 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce concurrencyGuard, accepting the legacy boolean (true→global, false→off). */
function coerceGuard(value: unknown, fallback: 'global' | 'own' | 'off'): 'global' | 'own' | 'off' {
  if (value === true) return 'global';
  if (value === false) return 'off';
  if (value === 'global' || value === 'own' || value === 'off') return value;
  return fallback;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

const VALID_POLICIES: readonly CategoryPolicy[] = ['always', 'workflow', 'workhours', 'digest', 'off'];
function coercePolicy(value: unknown, fallback: CategoryPolicy): CategoryPolicy {
  return (VALID_POLICIES as readonly string[]).includes(value as string) ? (value as CategoryPolicy) : fallback;
}

function coerceDayWindow(value: unknown, fallback: WorkflowDayWindow): WorkflowDayWindow {
  const v = (value ?? {}) as Partial<WorkflowDayWindow>;
  return { start: coerceString(v.start, fallback.start), end: coerceString(v.end, fallback.end) };
}

/**
 * Merge a partial notifications block onto the defaults, coercing every field so
 * a hand-edited or partial settings.json can never produce an invalid policy,
 * a non-string timezone, or a missing channel flag.
 */
function coerceNotifications(
  raw: unknown,
  d: NotificationsSettings,
): NotificationsSettings {
  const r = (raw ?? {}) as Partial<NotificationsSettings>;
  const sched = (r.workflow?.schedule ?? {}) as Partial<NotificationsSettings['workflow']['schedule']>;
  const ds = d.workflow.schedule;
  return {
    channels: {
      slack: coerceBool(r.channels?.slack, d.channels.slack),
      pushover: { enabled: coerceBool(r.channels?.pushover?.enabled, d.channels.pushover.enabled) },
    },
    workflow: {
      schedule: {
        mon: coerceDayWindow(sched.mon, ds.mon),
        tue: coerceDayWindow(sched.tue, ds.tue),
        wed: coerceDayWindow(sched.wed, ds.wed),
        thu: coerceDayWindow(sched.thu, ds.thu),
        fri: coerceDayWindow(sched.fri, ds.fri),
        sat: coerceDayWindow(sched.sat, ds.sat),
        sun: coerceDayWindow(sched.sun, ds.sun),
        timezone: coerceString(sched.timezone, ds.timezone),
      },
      manualOverride: {
        active: coerceBool(r.workflow?.manualOverride?.active, d.workflow.manualOverride.active),
        expiresAt:
          typeof r.workflow?.manualOverride?.expiresAt === 'string'
            ? r.workflow.manualOverride.expiresAt
            : d.workflow.manualOverride.expiresAt,
      },
    },
    categories: {
      'action-required': coercePolicy(r.categories?.['action-required'], d.categories['action-required']),
      failure: coercePolicy(r.categories?.failure, d.categories.failure),
      delivery: coercePolicy(r.categories?.delivery, d.categories.delivery),
      status: coercePolicy(r.categories?.status, d.categories.status),
    },
  };
}

export function loadSettings(dataDir: string): NyxSettings {
  const path = resolve(dataDir, 'settings.json');
  if (!existsSync(path)) return SETTINGS_DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NyxSettings>;
    const d = SETTINGS_DEFAULTS;
    return {
      pipeline: {
        ...d.pipeline,
        ...(raw.pipeline ?? {}),
        concurrentCap: clampNumber(raw.pipeline?.concurrentCap, d.pipeline.concurrentCap, 1, 16),
      },
      dispatcher: {
        ...d.dispatcher,
        ...(raw.dispatcher ?? {}),
        maxChainDepth: clampNumber(raw.dispatcher?.maxChainDepth, d.dispatcher.maxChainDepth, 1, 10),
        taskTimeoutMs: clampNumber(raw.dispatcher?.taskTimeoutMs, d.dispatcher.taskTimeoutMs, 60_000, 120 * 60_000),
        concurrencyGuard: coerceGuard(raw.dispatcher?.concurrencyGuard, d.dispatcher.concurrencyGuard),
        maxConcurrentIso: clampNumber(raw.dispatcher?.maxConcurrentIso, d.dispatcher.maxConcurrentIso, 1, 6),
        maxConcurrentClaude: clampNumber(raw.dispatcher?.maxConcurrentClaude, d.dispatcher.maxConcurrentClaude, 1, 12),
        defaultModels: { ...d.dispatcher.defaultModels, ...(raw.dispatcher?.defaultModels ?? {}) },
      },
      plugins: { disabled: Array.isArray(raw.plugins?.disabled) ? raw.plugins!.disabled : [] },
      updates: {
        check: typeof raw.updates?.check === 'boolean' ? raw.updates.check : d.updates.check,
        autoApply: typeof raw.updates?.autoApply === 'boolean' ? raw.updates.autoApply : d.updates.autoApply,
      },
      notifications: coerceNotifications(raw.notifications, d.notifications),
    };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

/**
 * Operator settings — the desktop Settings tab writes Data/settings.json; the
 * dispatcher reads it here. Absent file or any malformed field falls back to
 * defaults, so a missing/partial settings.json never changes behavior.
 *
 * NAME / OPERATOR_NAME live in Data/.env (the scaffolding contract), not here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
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

/** Per-tool MCP permission disposition (mirrors the Agent SDK allow/ask/deny engine). */
export type McpToolPolicy = 'auto' | 'ask' | 'deny';

/**
 * MCP-plane resilience config (G-D). All best-effort / non-fatal — a disabled or
 * malformed block falls back to defaults that preserve today's behavior (breaker
 * never trips on the default threshold during a normal run; default policy `auto`
 * keeps every discovered MCP, matching the pre-resilience allowlist).
 */
export interface McpSettings {
  breaker: {
    // Consecutive failures for one server before its breaker opens. Generalizes
    // the documented SUPABASE_URL "3 consecutive 404s" rule (IBM default: 3).
    failureThreshold: number;
    // How long an open breaker stays open before one half-open probe is allowed.
    // Aligned to a tick boundary in practice (IBM default 60s; Nyx tick is 5m).
    cooldownMs: number;
  };
  probe: {
    // Pre-spawn readiness probe (claude mcp list) on/off + its hard timeout. The
    // probe must never become the hang it prevents, so the timeout is tight.
    enabled: boolean;
    timeoutMs: number;
    // Whether a `! Needs authentication` server is withheld pre-spawn. OFF by
    // default — the prior collect-everything design let the spawn try and the
    // reactive 401 classifier handles a true failure; proactively withholding a
    // needs-auth server denies one whose token may still work. A hard
    // `✗ Failed to connect` is ALWAYS withheld regardless of this flag.
    withholdNeedsAuth: boolean;
  };
  auth: {
    // Proactive auth-healer: refresh when past this fraction of the TTL window
    // (0.8 = the 80%-TTL point the spec literature converges on).
    refreshAtFraction: number;
    // Fallback TTL when a credential's last-refresh anchor is unknown.
    defaultTtlMs: number;
  };
  policy: {
    // Default disposition for any MCP server/tool not named in `tools`.
    defaultPolicy: McpToolPolicy;
    // Per-server (`mcp__server`) or per-tool (`mcp__server__tool`) overrides.
    tools: Record<string, McpToolPolicy>;
  };
}

export interface NyxSettings {
  pipeline: {
    concurrentCap: number;
    slackNotifications: boolean;
    autoMerge: boolean;
    reviewStrictness: 'lenient' | 'normal' | 'strict';
  };
  mcp: McpSettings;
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
  // Trace→eval→lesson loop FOUNDATION (G-A). Sampled async online-eval + drift
  // monitor. Observation-only: scores accumulate and the drift monitor DMs the
  // operator, but nothing here gates or blocks a task. `enabled: false` (the
  // default) keeps the entire eval layer dormant until the operator opts in.
  evaluation: {
    enabled: boolean;
    // Fraction (0..1) of CLEAN terminal runs to score each cadence. Flagged
    // runs (halt/audit/stall) are ALWAYS scored regardless of this rate.
    sampleRate: number;
    // The judge model — cheap by design (the judge is advisory, high-volume).
    judgeModel: string;
  };
  updates: {
    // check = dispatcher polls origin/main once a day and notifies when the
    // installed keg is behind. autoApply = also run 'nyx update' automatically
    // (off by default — auto-replacing running code is opt-in).
    check: boolean;
    autoApply: boolean;
  };
  // Stable actor identity for this Nyx instance. Every line the activity ledger
  // renders is prefixed with this token, so a future hub-side rollup across
  // federated instances can attribute each entry to the instance that produced
  // it. Defaults to `nyx@<hostname>`; the operator overrides it via settings.json
  // (or the desktop) when running multiple instances behind one hub. This is the
  // FEDERATION KEY — keep it stable across renders for a given install.
  instanceName: string;
  notifications: NotificationsSettings;
}

/** Default instance identity: `nyx@<hostname>`. Computed once per process. */
export const DEFAULT_INSTANCE_NAME = `nyx@${hostname()}`;

export const SETTINGS_DEFAULTS: NyxSettings = {
  pipeline: { concurrentCap: 4, slackNotifications: true, autoMerge: false, reviewStrictness: 'normal' },
  mcp: {
    // Breaker opens after 3 consecutive failures (the SUPABASE_URL rule, IBM
    // default), 5-minute cooldown = one tick. probe ON but cheap. defaultPolicy
    // `auto` = every discovered MCP stays in the allowlist (today's behavior).
    breaker: { failureThreshold: 3, cooldownMs: 5 * 60_000 },
    probe: { enabled: true, timeoutMs: 4000, withholdNeedsAuth: false },
    auth: { refreshAtFraction: 0.8, defaultTtlMs: 60 * 60_000 },
    policy: { defaultPolicy: 'auto', tools: {} },
  },
  dispatcher: {
    maxChainDepth: 2,
    taskTimeoutMs: 30 * 60_000,
    concurrencyGuard: 'own',
    maxConcurrentIso: 2,
    maxConcurrentClaude: 4,
    defaultModels: { code: 'sonnet', analysis: 'opus', content: 'sonnet', assistant: 'haiku', pipeline: 'opus' },
  },
  plugins: { disabled: [] },
  // 0.1 sampling is the canonical online-eval rate; haiku is the cheap judge.
  // OFF by default — the loop accumulates no scores until the operator enables it.
  evaluation: { enabled: false, sampleRate: 0.1, judgeModel: 'haiku' },
  updates: { check: true, autoApply: false },
  instanceName: DEFAULT_INSTANCE_NAME,
  notifications: {
    // Slack on, Pushover off by default → with no settings.json present, behavior
    // is exactly today's (Slack-only). Pushover opts in via settings + creds.
    channels: { slack: true, pushover: { enabled: false } },
    workflow: {
      // No working windows defined out of the box. An UNCONFIGURED schedule (every
      // day empty) means Workflow is ALWAYS ACTIVE — "no working hours set" ==
      // "always reachable", never "never reachable". This is the safe default: it
      // keeps 'workflow'/'workhours' categories (incl. urgent action-required and
      // failure alerts) delivering live until the operator opts into suppression by
      // setting at least one real window via the desktop (N3). See
      // `scheduleIsConfigured` in notification-policy.ts.
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

const VALID_TOOL_POLICIES: readonly McpToolPolicy[] = ['auto', 'ask', 'deny'];
function coerceToolPolicy(value: unknown, fallback: McpToolPolicy): McpToolPolicy {
  return (VALID_TOOL_POLICIES as readonly string[]).includes(value as string)
    ? (value as McpToolPolicy)
    : fallback;
}

/**
 * Merge a partial mcp block onto the defaults, coercing every field so a
 * hand-edited settings.json can never produce a non-finite threshold, a bogus
 * policy string, or a non-record tools map. An invalid per-tool policy value is
 * dropped to the default rather than letting an unknown string reach the spawn.
 */
function coerceMcp(raw: unknown, d: McpSettings): McpSettings {
  const r = (raw ?? {}) as Partial<McpSettings>;
  const tools: Record<string, McpToolPolicy> = {};
  const rawTools = (r.policy?.tools ?? {}) as Record<string, unknown>;
  if (rawTools && typeof rawTools === 'object') {
    for (const [key, val] of Object.entries(rawTools)) {
      if ((VALID_TOOL_POLICIES as readonly string[]).includes(val as string)) {
        tools[key] = val as McpToolPolicy;
      }
    }
  }
  return {
    breaker: {
      failureThreshold: clampNumber(r.breaker?.failureThreshold, d.breaker.failureThreshold, 1, 100),
      cooldownMs: clampNumber(r.breaker?.cooldownMs, d.breaker.cooldownMs, 1000, 60 * 60_000),
    },
    probe: {
      enabled: coerceBool(r.probe?.enabled, d.probe.enabled),
      timeoutMs: clampNumber(r.probe?.timeoutMs, d.probe.timeoutMs, 500, 30_000),
      withholdNeedsAuth: coerceBool(r.probe?.withholdNeedsAuth, d.probe.withholdNeedsAuth),
    },
    auth: {
      refreshAtFraction: clampNumber(r.auth?.refreshAtFraction, d.auth.refreshAtFraction, 0.1, 1),
      defaultTtlMs: clampNumber(r.auth?.defaultTtlMs, d.auth.defaultTtlMs, 60_000, 30 * 24 * 60 * 60_000),
    },
    policy: {
      defaultPolicy: coerceToolPolicy(r.policy?.defaultPolicy, d.policy.defaultPolicy),
      tools,
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
      evaluation: {
        enabled: coerceBool(raw.evaluation?.enabled, d.evaluation.enabled),
        // Clamp the rate into [0,1]; a hand-edited >1 or negative would otherwise
        // sample everything / nothing. 0 is legal (flagged-only scoring).
        sampleRate: clampNumber(raw.evaluation?.sampleRate, d.evaluation.sampleRate, 0, 1),
        judgeModel: coerceString(raw.evaluation?.judgeModel, d.evaluation.judgeModel),
      },
      updates: {
        check: typeof raw.updates?.check === 'boolean' ? raw.updates.check : d.updates.check,
        autoApply: typeof raw.updates?.autoApply === 'boolean' ? raw.updates.autoApply : d.updates.autoApply,
      },
      // A blank/whitespace-only instanceName falls back to the hostname default —
      // an empty federation key would make every ledger line ambiguous.
      instanceName:
        typeof raw.instanceName === 'string' && raw.instanceName.trim().length > 0
          ? raw.instanceName.trim()
          : d.instanceName,
      notifications: coerceNotifications(raw.notifications, d.notifications),
      mcp: coerceMcp(raw.mcp, d.mcp),
    };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

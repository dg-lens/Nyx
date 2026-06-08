/**
 * Operator settings — the desktop Settings tab writes Data/settings.json; the
 * dispatcher reads it here. Absent file or any malformed field falls back to
 * defaults, so a missing/partial settings.json never changes behavior.
 *
 * NAME / OPERATOR_NAME live in Data/.env (the scaffolding contract), not here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    // 'global' = skip a tick if ANY claude CLI is running (single-tenant box).
    // 'own'    = skip only if a NYX-spawned claude is still live (multi-tenant: a
    //            box also running another agent system, e.g. a pm2 claude swarm).
    // 'off'    = never skip; rely on the dispatch lockfile alone.
    concurrencyGuard: 'global' | 'own' | 'off';
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
}

export const SETTINGS_DEFAULTS: NyxSettings = {
  pipeline: { concurrentCap: 4, slackNotifications: true, autoMerge: false, reviewStrictness: 'normal' },
  dispatcher: {
    maxChainDepth: 2,
    taskTimeoutMs: 30 * 60_000,
    concurrencyGuard: 'global',
    defaultModels: { code: 'sonnet', analysis: 'opus', content: 'sonnet', assistant: 'haiku', pipeline: 'opus' },
  },
  plugins: { disabled: [] },
  updates: { check: true, autoApply: false },
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
        defaultModels: { ...d.dispatcher.defaultModels, ...(raw.dispatcher?.defaultModels ?? {}) },
      },
      plugins: { disabled: Array.isArray(raw.plugins?.disabled) ? raw.plugins!.disabled : [] },
      updates: {
        check: typeof raw.updates?.check === 'boolean' ? raw.updates.check : d.updates.check,
        autoApply: typeof raw.updates?.autoApply === 'boolean' ? raw.updates.autoApply : d.updates.autoApply,
      },
    };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

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
    concurrencyGuard: boolean;
    defaultModels: Record<string, string>;
  };
  plugins: { disabled: string[] };
}

export const SETTINGS_DEFAULTS: NyxSettings = {
  pipeline: { concurrentCap: 4, slackNotifications: true, autoMerge: false, reviewStrictness: 'normal' },
  dispatcher: {
    maxChainDepth: 2,
    taskTimeoutMs: 30 * 60_000,
    concurrencyGuard: true,
    defaultModels: { code: 'sonnet', analysis: 'opus', content: 'sonnet', assistant: 'haiku', pipeline: 'opus' },
  },
  plugins: { disabled: [] },
};

export function loadSettings(dataDir: string): NyxSettings {
  const path = resolve(dataDir, 'settings.json');
  if (!existsSync(path)) return SETTINGS_DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NyxSettings>;
    const d = SETTINGS_DEFAULTS;
    return {
      pipeline: { ...d.pipeline, ...(raw.pipeline ?? {}) },
      dispatcher: {
        ...d.dispatcher,
        ...(raw.dispatcher ?? {}),
        defaultModels: { ...d.dispatcher.defaultModels, ...(raw.dispatcher?.defaultModels ?? {}) },
      },
      plugins: { disabled: Array.isArray(raw.plugins?.disabled) ? raw.plugins!.disabled : [] },
    };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

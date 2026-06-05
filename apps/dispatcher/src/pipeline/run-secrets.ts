/**
 * Per-pipeline-run secret store + gate decisions.
 *
 * Each run can override global Data/.env secrets with values scoped to JUST that
 * run — e.g. a separate API key for a pipeline-built app to monitor its own
 * usage, distinct from Nyx's own key. Plaintext files mirroring .env, written by
 * the desktop preview gate, read here at execution, deleted at delivery/abort.
 *
 *   Data/pipeline-secrets/<runId>.env             — KEY=value overrides
 *   Data/pipeline-secrets/<runId>.decisions.json  — operator gate Y/N answers
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

function secretsDir(): string {
  return resolve(config.dataDir, 'pipeline-secrets');
}
export function runSecretsPath(runId: string): string {
  return resolve(secretsDir(), `${runId}.env`);
}
export function runDecisionsPath(runId: string): string {
  return resolve(secretsDir(), `${runId}.decisions.json`);
}

export function loadRunSecrets(runId: string): Record<string, string> {
  const p = runSecretsPath(runId);
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Env for a run's execution spawns: global process.env (which already carries
 * Data/.env) with this run's per-run overrides layered ON TOP (custom wins).
 */
export function pipelineRunEnv(runId: string): NodeJS.ProcessEnv {
  return { ...process.env, ...loadRunSecrets(runId) };
}

export interface GateDecisionAnswer {
  question: string;
  answer: 'yes' | 'no';
  note?: string;
}

export function loadRunDecisions(runId: string): GateDecisionAnswer[] {
  const p = runDecisionsPath(runId);
  if (!existsSync(p)) return [];
  try {
    const r = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return Array.isArray(r) ? (r as GateDecisionAnswer[]) : [];
  } catch {
    return [];
  }
}

export function cleanupRunSecrets(runId: string): void {
  for (const p of [runSecretsPath(runId), runDecisionsPath(runId)]) {
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

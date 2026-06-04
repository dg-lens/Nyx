import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ENV_FILE = resolve(ROOT, '.env');

if (existsSync(ENV_FILE)) {
  loadEnv({ path: ENV_FILE });
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,
  queuePath: resolve(ROOT, 'nyx.md'),
  dbPath: resolve(ROOT, 'data', 'nyx.db'),
  cursorPath: resolve(ROOT, 'data', 'supabase-sync.cursor'),
  logPath: resolve(ROOT, 'logs', 'sync.log'),

  // Strip trailing slash AND any /rest/v1[/] suffix the user may have pasted
  // from the Supabase dashboard. The supabase client appends `/rest/v1` itself.
  supabaseUrl: (process.env['SUPABASE_URL'] ?? '')
    .replace(/\/+$/, '')
    .replace(/\/rest\/v\d+$/, ''),
  supabaseServiceKey: process.env['SUPABASE_SERVICE_KEY'] ?? '',

  // How often to poll the local SQLite for new audit rows and check the queue file.
  pollIntervalMs: int('SYNC_POLL_INTERVAL_MS', 15_000),
  // Max rows to push per HTTP request. Supabase REST tolerates ~1000 per insert
  // comfortably; we stay well under to avoid serverless edge timeouts.
  batchSize: int('SYNC_BATCH_SIZE', 200),
  // Retry backoff for transient failures (network blip, Supabase 5xx).
  retryBaseMs: int('SYNC_RETRY_BASE_MS', 2_000),
  retryMaxMs: int('SYNC_RETRY_MAX_MS', 60_000),
} as const;

export function assertConfigured(): void {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceKey) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
        `Add them to ~/Nyx/.env (see DEPLOY.md).`,
    );
  }
}

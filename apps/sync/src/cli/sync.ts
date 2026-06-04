import { slotOf } from '@nyx/dispatcher/dist/task-reader.js';

import { assertConfigured, config } from '../config.js';
import { readCursor, writeCursor } from '../cursor.js';
import {
  closeDb,
  lastSuccessAt,
  lastTickAt,
  readRowsAfter,
  rowsForSupabase,
  successRate24h,
  totalRows,
  verifyChain,
} from '../db.js';
import { maybeBuildSnapshot } from '../queue-snap.js';
import {
  ping,
  pushAuditRows,
  pushDispatcherStatus,
  pushQueueSnapshot,
} from '../supabase.js';

// ── tiny logger ─────────────────────────────────────────────────────
// Single writer: console.log only. The shell script (nyx-sync.sh start)
// uses `nohup … >> $LOGFILE` and the launchd plist's StandardOutPath points
// at the same file, so stdout IS the persisted log. Don't appendFileSync too
// or every line lands twice.

function logLine(level: 'info' | 'warn' | 'error', msg: string): void {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

// ── retry with bounded exponential backoff ──────────────────────────

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  let attempt = 0;
  let delay = config.retryBaseMs;
  while (attempt < 6) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const e = err as Error;
      logLine('warn', `${label} failed (attempt ${attempt}): ${e.message}`);
      if (attempt >= 6) return null;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, config.retryMaxMs);
    }
  }
  return null;
}

// ── one sync cycle ──────────────────────────────────────────────────

async function syncAuditRows(): Promise<number> {
  const cursor = readCursor();
  let lastSynced = cursor;
  let totalPushed = 0;

  // Push in batches until we've drained the new rows. This keeps the per-request
  // payload bounded even if we've been offline for hours.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = readRowsAfter(lastSynced, config.batchSize);
    if (rows.length === 0) break;

    const supabaseRows = rowsForSupabase(rows);
    const n = await withRetry('pushAuditRows', () => pushAuditRows(supabaseRows));
    if (n == null) {
      // Hard failure after retries — leave cursor where it is, try next cycle.
      logLine('error', `audit push failed; cursor stays at ${lastSynced}`);
      return totalPushed;
    }
    lastSynced = rows[rows.length - 1]!.id;
    writeCursor(lastSynced);
    totalPushed += n;

    if (rows.length < config.batchSize) break;
  }
  return totalPushed;
}

async function syncQueueSnapshot(force = false): Promise<boolean> {
  const snap = maybeBuildSnapshot(force);
  if (!snap) return false;
  const id = await withRetry('pushQueueSnapshot', () => pushQueueSnapshot(snap));
  if (id == null) {
    logLine('error', 'queue snapshot push failed');
    return false;
  }
  logLine('info', `queue snapshot pushed: id=${id} active=${snap.active.length} completed=${snap.completed.length}`);
  return true;
}

async function syncStatus(): Promise<boolean> {
  const chain = verifyChain();
  const update = {
    last_tick_at: lastTickAt(),
    last_success_at: lastSuccessAt(),
    audit_row_count: totalRows(),
    chain_ok: chain.ok,
    success_rate_24h: successRate24h(),
    current_slot: slotOf(),
    notes: chain.ok ? {} : { chainBrokenAtRow: chain.firstBadRowId },
  };
  const ok = await withRetry('pushDispatcherStatus', () => pushDispatcherStatus(update));
  return ok != null;
}

async function cycle(force = false): Promise<void> {
  const pushedAudit = await syncAuditRows();
  const pushedSnap = await syncQueueSnapshot(force);
  const okStatus = await syncStatus();
  if (pushedAudit > 0 || pushedSnap) {
    logLine('info', `cycle done: audit_rows=${pushedAudit} snapshot=${pushedSnap ? 'sent' : 'unchanged'} status=${okStatus ? 'ok' : 'failed'}`);
  }
}

// ── entry ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has('--once');

  try {
    assertConfigured();
  } catch (err) {
    console.error('[sync]', (err as Error).message);
    process.exit(2);
  }

  logLine('info', `sync starting — supabase=${config.supabaseUrl} poll=${config.pollIntervalMs}ms once=${once}`);

  const health = await ping();
  if (!health.ok) {
    logLine('error', `Supabase ping failed: ${health.reason}`);
    if (once) process.exit(3);
    // For the daemon path we still try — credentials may recover, project may reboot.
  } else {
    logLine('info', `Supabase reachable (${health.sampleCount} sample rows)`);
  }

  // Initial pass forces a queue snapshot even if nyx.md hasn't moved since last run.
  await cycle(true);

  if (once) {
    closeDb();
    return;
  }

  const tick = async () => {
    try {
      await cycle();
    } catch (err) {
      logLine('error', `cycle threw: ${(err as Error).stack ?? (err as Error).message}`);
    }
  };
  const interval = setInterval(tick, config.pollIntervalMs);

  const shutdown = (sig: string) => {
    logLine('info', `${sig} received, shutting down`);
    clearInterval(interval);
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[sync] fatal:', err);
  process.exit(1);
});

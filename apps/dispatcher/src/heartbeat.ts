import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

export function writeHeartbeat(slot: number, dest?: string): void {
  const path = dest ?? `${config.dataDir}/data/heartbeat.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, slot }),
    'utf8',
  );
}

/**
 * Minutes elapsed since the last successful tick heartbeat.
 *
 * The shell (`nyx-dispatch.sh`) is the single writer: on `tick exit 0` it writes
 * the wall-clock epoch (seconds) to `$NYX_DATA_DIR/data/last-tick-ok`. This pure
 * function turns that epoch into a gap so the dispatcher can self-detect an
 * outage that just ended (the prior process never wrote, so the gap is large on
 * the first healthy tick after recovery).
 *
 * - `null`  when there is no heartbeat (never ticked) — nothing to compare.
 * - `0`     when the heartbeat is future-dated (clock skew) — treat as healthy,
 *           never as a gap.
 * - minutes otherwise (floored).
 */
export function tickGapMinutes(lastOkEpochSec: number | null, nowMs: number): number | null {
  if (lastOkEpochSec === null || !Number.isFinite(lastOkEpochSec)) return null;
  const deltaMs = nowMs - lastOkEpochSec * 1000;
  if (deltaMs <= 0) return 0;
  return Math.floor(deltaMs / 60_000);
}

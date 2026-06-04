import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

/**
 * Tracks the last successfully-synced audit row id. Written atomically (tmp + rename)
 * so a crash mid-write can't corrupt the cursor. Missing file = start from id 0.
 */
export function readCursor(): number {
  if (!existsSync(config.cursorPath)) return 0;
  try {
    const raw = readFileSync(config.cursorPath, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeCursor(id: number): void {
  mkdirSync(dirname(config.cursorPath), { recursive: true });
  const tmp = `${config.cursorPath}.tmp`;
  writeFileSync(tmp, String(id), 'utf8');
  renameSync(tmp, config.cursorPath);
}

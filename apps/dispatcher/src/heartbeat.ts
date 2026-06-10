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

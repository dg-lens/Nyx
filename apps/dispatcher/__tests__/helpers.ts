import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _setAppsDir } from '../src/config.js';

/**
 * Run `fn` with config.appsDir pointed at a fresh throwaway tmpdir, via the
 * _setAppsDir test seam (config is `as const` — direct property mutation is a
 * type error AND would leak across tests). The override is always cleared and
 * the tmpdir removed, pass or fail.
 */
export function withAppsDir<T>(fn: (appsDir: string) => T): T {
  const appsDir = mkdtempSync(join(tmpdir(), 'nyx-apps-'));
  _setAppsDir(appsDir);
  try {
    return fn(appsDir);
  } finally {
    _setAppsDir(null);
    rmSync(appsDir, { recursive: true, force: true });
  }
}

/** Async variant of withAppsDir — awaits fn before clearing the override. */
export async function withAppsDirAsync<T>(fn: (appsDir: string) => Promise<T>): Promise<T> {
  const appsDir = mkdtempSync(join(tmpdir(), 'nyx-apps-'));
  _setAppsDir(appsDir);
  try {
    return await fn(appsDir);
  } finally {
    _setAppsDir(null);
    rmSync(appsDir, { recursive: true, force: true });
  }
}

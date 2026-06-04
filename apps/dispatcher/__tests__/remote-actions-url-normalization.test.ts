/**
 * URL normalization tests for the remote-actions poller.
 *
 * Root cause addressed: SUPABASE_URL stored with a /rest/v1[/] suffix (copied
 * from the Supabase dashboard) caused fetchPending to build a double path
 * (/rest/v1/rest/v1/nyx_pending_actions → 404 → circuit breaker tripped).
 *
 * These tests verify that processRemoteActions normalizes the URL regardless of
 * whether it arrives via config (already stripped by config.ts) or via the test
 * seam _setSupabaseConfig (normalized at the use-site in remote-actions.ts).
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import {
  _clearSupabaseConfig,
  _setCircuitPath,
  _setSupabaseConfig,
  processRemoteActions,
} from '../src/remote-actions.js';

let tmpDir: string;
let memDb: DatabaseSync;
let originalFetch: typeof fetch;

function setupAuditDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
    CREATE INDEX idx_system_audit_event ON system_audit(event);
    CREATE INDEX idx_system_audit_at    ON system_audit(at);
  `);
  return db;
}

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-url-norm-test-'));
  _setCircuitPath(resolve(tmpDir, 'remote-actions-circuit.json'));
  memDb = setupAuditDb();
  _setAuditDb(memDb);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setAuditDb(null);
  _clearSupabaseConfig();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Supabase URL normalization — no double /rest/v1 path', () => {
  const urlForms = [
    'https://proj.supabase.co/rest/v1',   // bare suffix, no trailing slash
    'https://proj.supabase.co/rest/v1/',  // suffix + trailing slash (common dashboard paste)
    'https://proj.supabase.co',            // already clean
    'https://proj.supabase.co/',           // clean with trailing slash
  ];

  for (const rawUrl of urlForms) {
    test(`"${rawUrl}" → fetch URL contains /rest/v1/nyx_pending_actions exactly once`, async () => {
      _setSupabaseConfig(rawUrl, 'test-key');

      let capturedUrl: string | undefined;
      globalThis.fetch = (url) => {
        capturedUrl = String(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve([]),
        } as Response);
      };

      await processRemoteActions();

      assert.ok(capturedUrl !== undefined, 'fetch must have been called');
      assert.ok(
        !capturedUrl.includes('/rest/v1/rest/v1'),
        `double path found in: ${capturedUrl}`,
      );
      assert.ok(
        capturedUrl.includes('/rest/v1/nyx_pending_actions'),
        `expected table path not found in: ${capturedUrl}`,
      );
    });
  }
});

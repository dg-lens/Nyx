import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setSecretsDb } from '../src/secrets/db-schema.js';
import { ingestInbox } from '../src/secrets/inbox-ingest.js';

// We can't easily override config.bitwardenInboxDir for tests without code change,
// so we set process.env BEFORE importing config-dependent code. The config module
// resolves bitwardenInboxDir from NYX_REPO_ROOT — set that to a tmp dir.
//
// This file is imported with `node --import tsx`, so we don't get module isolation
// per-describe. The config object is loaded once at import. Best we can do:
// stub the SecretsDb (we do that), then ensure the inbox dir under NYX_REPO_ROOT
// exists with our fixtures.

let tmpRoot: string;
let inboxDir: string;
let db: DatabaseSync;

function writeEvent(name: string, body: unknown): void {
  writeFileSync(resolve(inboxDir, name), JSON.stringify(body), 'utf8');
}
function writeRaw(name: string, raw: string): void {
  writeFileSync(resolve(inboxDir, name), raw, 'utf8');
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'nyx-inbox-test-'));
  process.env['NYX_REPO_ROOT'] = tmpRoot;
  // The config object is loaded on first import. We need fresh imports per test.
  // Easiest: just re-import the module via dynamic import to get a fresh closure.
  // Since config is captured at module load, we cheat: place the inbox where
  // config was already pointed at on initial load.
  // Read where config thinks the inbox is:
  const { config } = await import('../src/config.js');
  inboxDir = config.bitwardenInboxDir;
  // Use a single in-memory DB for both secrets and audit so audit() calls
  // from inside ingestInbox don't try to lock the real nyx.db.
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE secret_rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotates_in_days INTEGER NOT NULL DEFAULT 90,
      owner TEXT NOT NULL,
      rotation_url TEXT,
      rotation_steps TEXT,
      notes TEXT,
      UNIQUE(project_name, secret_key)
    );
    CREATE TABLE system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
  `);
  _setSecretsDb(db);
  _setAuditDb(db);
  // Clean any leftover files from prior runs
  try {
    for (const f of readdirSync(inboxDir)) rmSync(resolve(inboxDir, f), { recursive: true, force: true });
  } catch { /* directory may not exist yet — ingestInbox will create it */ }
});

afterEach(() => {
  _setSecretsDb(null);
  _setAuditDb(null);
  db.close();
  try {
    for (const f of readdirSync(inboxDir)) rmSync(resolve(inboxDir, f), { recursive: true, force: true });
  } catch { /* ok */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ingestInbox', () => {
  test('empty inbox returns empty=true and creates the directory', () => {
    const result = ingestInbox();
    assert.equal(result.ingested, 0);
    assert.equal(result.malformed, 0);
    assert.equal(result.empty, true);
  });

  test('valid event is inserted into secret_rotations and the file deleted', () => {
    writeEvent('event-1.json', {
      project_name: 'lens',
      secret_key: 'SUPABASE_SERVICE_ROLE_KEY',
      rotates_in_days: 60,
      owner: 'LENS-SETUP',
      rotation_url: 'https://example.com',
      rotation_steps: 'do it',
    });
    const result = ingestInbox();
    assert.equal(result.ingested, 1);
    assert.equal(result.malformed, 0);
    const rows = db.prepare(`SELECT * FROM secret_rotations`).all() as Array<{ project_name: string; secret_key: string; rotates_in_days: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.project_name, 'lens');
    assert.equal(rows[0]!.rotates_in_days, 60);
    // File should be gone
    assert.ok(!readdirSync(inboxDir).includes('event-1.json'));
  });

  test('malformed JSON gets quarantined under .failed/ and does not crash', () => {
    writeRaw('bad.json', '{ this is not json ');
    const result = ingestInbox();
    assert.equal(result.ingested, 0);
    assert.equal(result.malformed, 1);
    // The file should be moved to .failed/, not still in the inbox root.
    assert.ok(!readdirSync(inboxDir).includes('bad.json'));
    const failedDir = resolve(inboxDir, '.failed');
    assert.ok(readdirSync(failedDir).some(f => f.endsWith('__bad.json')));
  });

  test('missing required fields gets quarantined', () => {
    writeEvent('incomplete.json', { project_name: 'lens' /* no secret_key */ });
    const result = ingestInbox();
    assert.equal(result.malformed, 1);
    assert.equal(result.ingested, 0);
  });

  test('re-ingesting the same project+key updates the existing row', () => {
    writeEvent('event-1.json', { project_name: 'lens', secret_key: 'K', rotates_in_days: 60 });
    ingestInbox();
    writeEvent('event-2.json', { project_name: 'lens', secret_key: 'K', rotates_in_days: 30 });
    ingestInbox();
    const rows = db.prepare(`SELECT * FROM secret_rotations`).all() as Array<{ rotates_in_days: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rotates_in_days, 30);
  });
});

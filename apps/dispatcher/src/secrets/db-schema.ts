import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';

/**
 * Secrets-related schema, kept in a sibling module so audit.ts stays focused
 * on the hash chain. These tables are MUTABLE state, NOT hash-chained — but
 * every mutation MUST still emit an audit event (handled by callers).
 *
 * Idempotent — safe to call on every dispatcher startup. The DB connection
 * is reused; node:sqlite is process-local.
 */

let db: DatabaseSync | null = null;

export function openSecretsDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bitwarden_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      bw_project_id TEXT NOT NULL,
      bw_machine_account_id TEXT NOT NULL,
      token_path TEXT NOT NULL,
      repos_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secret_rotations (
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

    CREATE INDEX IF NOT EXISTS idx_secret_rotations_due
      ON secret_rotations (((created_at / 1000) + (rotates_in_days * 86400)));
  `);
  return db;
}

/** For tests — swap in an in-memory or alternate-path DB. */
export function _setSecretsDb(newDb: DatabaseSync | null): void {
  db = newDb;
}

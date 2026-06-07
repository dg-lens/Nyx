import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';

import { openSecretsDb } from './db-schema.js';

/**
 * Child-process inbox pattern.
 *
 * Spawned Claude subprocesses can't safely talk to the main SQLite from inside
 * their sandbox (and we don't want them to). They drop rotation events as
 * JSON files into ~/Nyx/inbox/rotation-events/ instead. The dispatcher
 * ingests them on every tick before picking the next task.
 *
 * One file per event. We upsert into secret_rotations and delete the file.
 * Malformed files get quarantined under .failed/ with a timestamp suffix so
 * a bad payload never crashes the dispatcher or wedges the inbox.
 */

export interface RotationEvent {
  project_name: string;
  secret_key: string;
  rotates_in_days?: number;
  owner?: string;
  rotation_url?: string | null;
  rotation_steps?: string | null;
  notes?: string | null;
}

export interface IngestResult {
  ingested: number;
  malformed: number;
  empty: boolean;
}

function isValidRotationEvent(o: unknown): o is RotationEvent {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  if (typeof r['project_name'] !== 'string' || !r['project_name']) return false;
  if (typeof r['secret_key'] !== 'string' || !r['secret_key']) return false;
  if (r['rotates_in_days'] !== undefined && typeof r['rotates_in_days'] !== 'number') return false;
  return true;
}

function quarantine(filePath: string, fileName: string, reason: string): void {
  const dir = resolve(config.bitwardenInboxDir, '.failed');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = resolve(dir, `${stamp}__${fileName}`);
  try {
    renameSync(filePath, dest);
  } catch {
    // If we can't even rename it (permission etc.), just unlink so the inbox doesn't wedge.
    try { unlinkSync(filePath); } catch { /* swallow */ }
  }
  audit('inbox.rotation.malformed', 'inbox-ingest', { file: fileName, reason, quarantine: dest });
}

function upsertRotation(ev: RotationEvent, fileName: string): { isNew: boolean } {
  const db = openSecretsDb();
  const rotates = ev.rotates_in_days ?? config.bitwardenDefaultRotationDays;
  const owner = ev.owner ?? 'unknown';
  const existing = db
    .prepare(`SELECT id FROM secret_rotations WHERE project_name = ? AND secret_key = ? LIMIT 1`)
    .get(ev.project_name, ev.secret_key) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE secret_rotations
         SET rotates_in_days = ?, owner = ?, rotation_url = ?, rotation_steps = ?, notes = ?
       WHERE id = ?`,
    ).run(
      rotates,
      owner,
      ev.rotation_url ?? null,
      ev.rotation_steps ?? null,
      ev.notes ?? null,
      existing.id,
    );
    audit('bitwarden.secret.rotation_updated', 'inbox-ingest', {
      project_name: ev.project_name,
      secret_key: ev.secret_key,
      rotates_in_days: rotates,
      owner,
      source_file: fileName,
    });
    return { isNew: false };
  }
  db.prepare(
    `INSERT INTO secret_rotations
       (project_name, secret_key, created_at, rotates_in_days, owner, rotation_url, rotation_steps, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.project_name,
    ev.secret_key,
    Date.now(),
    rotates,
    owner,
    ev.rotation_url ?? null,
    ev.rotation_steps ?? null,
    ev.notes ?? null,
  );
  audit('bitwarden.secret.rotation_logged', 'inbox-ingest', {
    project_name: ev.project_name,
    secret_key: ev.secret_key,
    rotates_in_days: rotates,
    owner,
    source_file: fileName,
  });
  return { isNew: true };
}

/**
 * Process all .json files in the inbox. Returns counts for the caller. Always
 * resolves — never throws — so a single bad file can't take down the dispatcher.
 */
export function ingestInbox(): IngestResult {
  const dir = config.bitwardenInboxDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return { ingested: 0, malformed: 0, empty: true };
  }

  let ingested = 0;
  let malformed = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return { ingested: 0, malformed: 0, empty: true };
  }

  for (const name of entries) {
    const filePath = resolve(dir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      quarantine(filePath, name, `read failed: ${(err as Error).message}`);
      malformed++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      quarantine(filePath, name, `invalid JSON: ${(err as Error).message}`);
      malformed++;
      continue;
    }
    if (!isValidRotationEvent(parsed)) {
      quarantine(filePath, name, 'missing required fields project_name/secret_key');
      malformed++;
      continue;
    }
    try {
      upsertRotation(parsed, name);
      ingested++;
      try { unlinkSync(filePath); } catch { /* file may already be gone */ }
    } catch (err) {
      quarantine(filePath, name, `db upsert failed: ${(err as Error).message}`);
      malformed++;
    }
  }

  if (ingested > 0) {
    audit('inbox.rotation.ingested', 'inbox-ingest', { count: ingested, malformed });
  }
  return { ingested, malformed, empty: entries.length === 0 };
}

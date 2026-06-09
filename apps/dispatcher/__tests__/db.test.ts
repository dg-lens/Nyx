import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { openDb } from '../src/db.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'nyx-db-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDb (M12 — shared SQLite pragmas)', () => {
  test('applies WAL + busy_timeout=5000 + synchronous=NORMAL', () => {
    const db = openDb(resolve(dir, 'nyx.db'));
    try {
      const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const bt = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      const sy = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
      assert.equal(String(jm.journal_mode).toLowerCase(), 'wal');
      assert.equal(bt.timeout, 5000, 'busy_timeout MUST be set (the M12 bug: it defaulted to 0)');
      assert.equal(sy.synchronous, 1, 'synchronous=NORMAL (1) — WAL-recommended');
    } finally {
      db.close();
    }
  });

  test('busy_timeout is applied to EVERY connection, not just the first (per-connection pragma)', () => {
    const path = resolve(dir, 'nyx.db');
    const a = openDb(path);
    const b = openDb(path);
    try {
      // The M12 hazard: WAL persists at the db level, so a second opener that
      // forgot busy_timeout would read 0 here. openDb guarantees 5000 on each.
      const btA = a.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      const btB = b.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      assert.equal(btA.timeout, 5000);
      assert.equal(btB.timeout, 5000);

      // Two connections to the same file can both write (non-overlapping) without
      // a dropped-write SQLITE_BUSY.
      a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      a.exec("INSERT INTO t (v) VALUES ('a')");
      b.exec("INSERT INTO t (v) VALUES ('b')");
      const n = (b.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c;
      assert.equal(n, 2);
    } finally {
      a.close();
      b.close();
    }
  });
});

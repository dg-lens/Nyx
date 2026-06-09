import { DatabaseSync } from 'node:sqlite';

/**
 * Open a SQLite connection with the pragmas every Nyx process MUST share.
 *
 * `journal_mode = WAL` is a DATABASE-level setting (it persists across opens),
 * but `busy_timeout` is PER-CONNECTION and resets to 0 on every fresh open — so
 * any opener that sets WAL yet forgets busy_timeout gets an immediate
 * SQLITE_BUSY the instant another process holding a write lock contends, and
 * silently drops the write. The daemon, the SwiftUI app, the audit writer, and
 * pipeline runs all share nyx.db, so every opener routes through here (M12).
 *
 * `synchronous = NORMAL` is the SQLite-recommended companion to WAL: it is
 * corruption-safe (a power loss can only lose the last committed transaction,
 * never corrupt the file) and materially faster under concurrent writers. The
 * caller is responsible for ensuring the parent directory exists.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

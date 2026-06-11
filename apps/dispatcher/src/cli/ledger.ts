/**
 * `nyx ledger [--days N] [--since ISO]` — render the system activity ledger.
 *
 * Writes the narrative projection of system_audit to
 * `$NYX_DATA_DIR/ledger/LEDGER.md`. The morning brief / digest tasks read THIS
 * doc first; the chain is the source of truth, this is the readable surface.
 *
 * Defaults to a 7-day lookback. `--since 2026-06-01T00:00:00Z` pins the lower
 * bound explicitly (used when a brief wants a fixed window).
 */

import { LEDGER_PATH, writeLedger, type RenderOptions } from '../ledger.js';

function usage(): void {
  process.stderr.write(
    `Usage: nyx ledger [--days N] [--since ISO]\n\n` +
      `  Render the system activity ledger from system_audit.\n` +
      `  --days N    lookback window in days (default 7)\n` +
      `  --since ISO ISO timestamp lower bound; overrides --days\n` +
      `  --help      print this message\n\n` +
      `  Output is written to ${LEDGER_PATH}\n`,
  );
}

function parseArgs(argv: string[]): RenderOptions | { help: true } | { error: string } {
  const out: RenderOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--days') {
      const v = argv[i + 1];
      if (!v) return { error: '--days requires a value' };
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return { error: `--days expects a positive integer, got "${v}"` };
      out.windowDays = n;
      i += 1;
      continue;
    }
    if (a === '--since') {
      const v = argv[i + 1];
      if (!v) return { error: '--since requires an ISO timestamp' };
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) return { error: `--since expects an ISO timestamp, got "${v}"` };
      out.sinceIso = new Date(ms).toISOString();
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return out;
}

function main(): void {
  // Tolerate the shell wrapper passing `ledger` through as argv[0] of the residual.
  const raw = process.argv.slice(2);
  const argv = raw[0] === 'ledger' ? raw.slice(1) : raw;
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n`);
    usage();
    process.exit(2);
  }
  if ('help' in parsed) {
    usage();
    return;
  }
  const result = writeLedger(parsed);
  process.stdout.write(
    `wrote ${result.path} (${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, ${result.bytes} bytes)\n`,
  );
}

main();

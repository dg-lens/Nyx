/**
 * `nyx ledger [render] [--days N] [--since ISO]` — render the activity ledger.
 * `nyx ledger note "<text>" [--category C] [--ref R]` — record a manual note.
 * `nyx ledger show [--days N] [--since ISO]` — print the ledger to stdout.
 *
 * The ledger is the narrative projection of system_audit written to
 * `$NYX_DATA_DIR/ledger/LEDGER.md`. The morning brief / digest tasks read THIS
 * doc first; the chain is the source of truth, this is the readable surface.
 *
 * `render` (the default with no subcommand) writes the file. `show` writes it
 * AND prints it. `note` appends an operator note that renders under Notes.
 */

import { readFileSync } from 'node:fs';

import { addNote, LEDGER_PATH, writeLedgerFile, type RenderOptions } from '../ledger.js';

function usage(): void {
  process.stderr.write(
    `Usage:\n` +
      `  nyx ledger [render] [--days N] [--since ISO]\n` +
      `      Render the activity ledger from system_audit to ${LEDGER_PATH}.\n` +
      `  nyx ledger show [--days N] [--since ISO]\n` +
      `      Render the ledger and print it to stdout.\n` +
      `  nyx ledger note "<text>" [--category C] [--ref R]\n` +
      `      Record a manual operator note (renders under the Notes section).\n\n` +
      `  --days N     lookback window in days (default 7)\n` +
      `  --since ISO  ISO timestamp lower bound; overrides --days\n` +
      `  --category C note category label (default "note")\n` +
      `  --ref R      a reference the note hangs off (task id, PR url, doc path)\n` +
      `  --help       print this message\n`,
  );
}

function parseRenderArgs(argv: string[]): RenderOptions | { error: string } {
  const out: RenderOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
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

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  return undefined;
}

function runRender(argv: string[], print: boolean): void {
  const parsed = parseRenderArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n`);
    usage();
    process.exit(2);
  }
  const result = writeLedgerFile(parsed);
  if (print) {
    process.stdout.write(readFileSync(result.path, 'utf8'));
    return;
  }
  process.stdout.write(
    `wrote ${result.path} (${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, ${result.bytes} bytes)\n`,
  );
}

function runNote(argv: string[]): void {
  // The first positional (not a flag, not a flag's value) is the note text.
  const consumed = new Set<number>();
  for (const flag of ['--category', '--ref']) {
    const i = argv.indexOf(flag);
    if (i !== -1) {
      consumed.add(i);
      consumed.add(i + 1);
    }
  }
  const text = argv.find((a, i) => !consumed.has(i) && !a.startsWith('--'));
  if (!text) {
    process.stderr.write(`note requires a "<text>" argument\n\n`);
    usage();
    process.exit(2);
  }
  const category = flagValue(argv, '--category');
  const ref = flagValue(argv, '--ref');
  const note = addNote(text, { category, ref });
  process.stdout.write(`noted #${note.id} [${note.category}]${note.ref ? ` (${note.ref})` : ''}: ${note.text}\n`);
}

function main(): void {
  // Tolerate the shell wrapper passing `ledger` through as argv[0] of the residual.
  const raw = process.argv.slice(2);
  const args = raw[0] === 'ledger' ? raw.slice(1) : raw;

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  const sub = args[0];
  switch (sub) {
    case 'note':
      runNote(args.slice(1));
      return;
    case 'show':
      runRender(args.slice(1), true);
      return;
    case 'render':
      runRender(args.slice(1), false);
      return;
    default:
      // No subcommand (or flags only) → render.
      runRender(args, false);
      return;
  }
}

main();

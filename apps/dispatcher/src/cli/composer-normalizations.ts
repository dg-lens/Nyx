/**
 * nyx composer normalizations [--limit N] — review shadow normalizer output.
 *
 * Prints the most recent pre-dispatch normalizations (shadow stage): per task,
 * the solvable/complete verdict, the would_reject signal + reason, and any
 * predicted merge conflicts in the dependency chain. Read-only operator surface;
 * the normalizer itself never blocks dispatch.
 */

import { getRecentNormalizations } from '../composer/db.js';
import type { NormalizationResult } from '../composer/types.js';

const DEFAULT_LIMIT = 20;

function usage(): void {
  process.stderr.write(
    `Usage: nyx composer normalizations [--limit N]\n\n` +
      `  Lists recent SHADOW normalizer output for operator review.\n` +
      `  --limit N   max rows to show (default ${DEFAULT_LIMIT})\n`,
  );
}

function parseLimit(args: string[]): number {
  const i = args.indexOf('--limit');
  if (i !== -1 && args[i + 1]) {
    const n = Number.parseInt(args[i + 1]!, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LIMIT;
}

function fmt(n: NormalizationResult): string {
  const lines: string[] = [];
  const v = n.spec.verdict;
  const flag = n.would_reject ? 'WOULD-REJECT' : 'ok';
  lines.push(`${n.task_id}  solvable=${v.solvable} complete=${v.complete}  [${flag}]${n.enforced ? ' (enforced=on, shadow)' : ''}`);
  if (n.reject_reason) lines.push(`  reason:    ${n.reject_reason}`);
  if (v.redundant_with.length) lines.push(`  redundant: ${v.redundant_with.join(', ')}`);
  const conflicts = n.dag?.predicted_conflicts ?? [];
  if (conflicts.length) {
    for (const c of conflicts) {
      lines.push(`  conflict:  ${c.between[0]} ↔ ${c.between[1]} on ${c.files.join(', ')}`);
    }
  }
  if (n.dag?.cycle) lines.push(`  cycle:     ${n.dag.cycle.join(' → ')}`);
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  // Tolerate both `nyx composer normalizations` (the shell wrapper passes the
  // residual args) and a bare `normalizations` first arg.
  const args = argv[0] === 'normalizations' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const limit = parseLimit(args);
  const rows = getRecentNormalizations(limit);
  if (rows.length === 0) {
    process.stdout.write('No shadow normalizations recorded yet.\n');
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${fmt(r)}\n`);
  }
}

main();

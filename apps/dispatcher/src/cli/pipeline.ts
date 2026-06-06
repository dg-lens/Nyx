/**
 * nyx pipeline <subcommand> — operator control for pipeline runs.
 *
 *   nyx pipeline list                      list recent runs
 *   nyx pipeline status <RUN>              show a run + its gate brief path
 *   nyx pipeline go       <RUN> [--note]   preview gate: freeze + execute
 *   nyx pipeline revise   <RUN> --note "…" preview gate: re-plan with input
 *   nyx pipeline proceed  <RUN> [--note]   review gate: accept / ship
 *   nyx pipeline fix      <RUN> --note "…" review gate: corrective wave
 *   nyx pipeline rollback <RUN> [--note]   review gate: replan from scratch
 *   nyx pipeline abort    <RUN> [--note]   stop the run
 *
 * Decisions don't run work synchronously — they arm the run; the next dispatch
 * tick's resume scan advances it. (Run `nyx tick` to apply immediately.)
 */

import { getRun, listRuns } from '../pipeline/db.js';
import { submitDecision } from '../pipeline/decide.js';
import type { DecisionKind, PipelineRun } from '../pipeline/types.js';

const DECISION_VERBS = new Set<DecisionKind>(['go', 'revise', 'abort', 'proceed', 'fix', 'rollback', 'accept']);

function usage(): void {
  process.stderr.write(
    `Usage: nyx pipeline <subcommand> [args]\n\n` +
      `  list                       list recent runs\n` +
      `  status <RUN>               show a run + gate brief path\n` +
      `  go       <RUN> [--note T]  preview gate: freeze the plan + start coding\n` +
      `  revise   <RUN> --note T    preview gate: re-plan with your input\n` +
      `  accept   <RUN> [--note T]  review gate: merge the held task(s) + CONTINUE the build\n` +
      `  proceed  <RUN> [--note T]  review gate: ship only what already merged (stops here)\n` +
      `  fix      <RUN> --note T    review gate: corrective wave (re-code from phase 0)\n` +
      `  rollback <RUN> [--note T]  review gate: replan from scratch\n` +
      `  abort    <RUN> [--note T]  stop the run\n`,
  );
}

function parseNote(args: string[]): string {
  const i = args.indexOf('--note');
  if (i !== -1 && args[i + 1]) return args[i + 1]!;
  return '';
}

function fmtRun(r: PipelineRun): string {
  const stage = r.current_stage ? ` @${r.current_stage}` : '';
  const pend = r.operator_decision ? ` (decision pending: ${r.operator_decision.kind})` : '';
  return `${r.id}  ${r.status}${stage}  [${r.task_id}${r.repo ? ` · ${r.repo}` : ''}]${pend}`;
}

/** Short operator-facing notes about where the run is + what's pending. */
function statusNotes(r: PipelineRun): string[] {
  const notes: string[] = [];
  if (r.status === 'awaiting_preview') notes.push('at the PREVIEW gate — read the brief, then go / revise / abort');
  else if (r.status === 'awaiting_review') {
    notes.push('at the REVIEW gate — accept (merge held + continue) / proceed / fix / rollback / abort');
    try {
      const f = JSON.parse(r.redux_findings ?? '{}') as { held?: string[]; merged?: string[] };
      if (f.merged?.length) notes.push(`integrated: ${f.merged.join(', ')}`);
      if (f.held?.length) notes.push(`held: ${f.held.join(', ')}`);
    } catch {
      /* ignore */
    }
  } else if (r.status === 'executing') notes.push(`executing phase ${r.current_phase}`);
  else if (r.status === 'planning' || r.status === 'replanning') notes.push('planning…');
  if (r.operator_decision) notes.push(`decision '${r.operator_decision.kind}' queued — resumes next tick`);
  return notes;
}

/** The runnable decision commands for the run's current gate (empty if none). */
function decisionCommands(r: PipelineRun): string[] {
  if (r.status === 'awaiting_preview') {
    return [`nyx pipeline go ${r.id}`, `nyx pipeline revise ${r.id} --note "..."`, `nyx pipeline abort ${r.id}`];
  }
  if (r.status === 'awaiting_review') {
    return [
      `nyx pipeline accept ${r.id}`,
      `nyx pipeline proceed ${r.id}`,
      `nyx pipeline fix ${r.id} --note "..."`,
      `nyx pipeline rollback ${r.id}`,
      `nyx pipeline abort ${r.id}`,
    ];
  }
  return [];
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    process.exit(sub ? 0 : 1);
  }

  if (sub === 'list') {
    const runs = listRuns();
    if (runs.length === 0) {
      process.stdout.write('No pipeline runs yet.\n');
      return;
    }
    for (const r of runs) process.stdout.write(`${fmtRun(r)}\n`);
    return;
  }

  if (sub === 'status') {
    const runId = argv[1];
    if (!runId) {
      process.stderr.write('status: missing <RUN>\n');
      process.exit(1);
    }
    const r = getRun(runId);
    if (!r) {
      process.stderr.write(`status: no run '${runId}'\n`);
      process.exit(2);
    }
    process.stdout.write(`${fmtRun(r)}\n`);
    if (r.bz_brief_path) process.stdout.write(`  brief:  ${r.bz_brief_path}\n`);
    for (const n of statusNotes(r)) process.stdout.write(`  note:   ${n}\n`);
    if (r.error) process.stdout.write(`  error:  ${r.error}\n`);
    const cmds = decisionCommands(r);
    if (cmds.length) {
      process.stdout.write(`  decide:\n`);
      for (const c of cmds) process.stdout.write(`    ${c}\n`);
    }
    return;
  }

  if (DECISION_VERBS.has(sub as DecisionKind)) {
    const runId = argv[1];
    if (!runId) {
      process.stderr.write(`${sub}: missing <RUN>\n`);
      process.exit(1);
    }
    const note = parseNote(argv.slice(2));
    const result = submitDecision(runId, sub as DecisionKind, { note, source: 'cli' });
    if (!result.ok) {
      process.stderr.write(`[nyx pipeline] ${result.message}\n`);
      process.exit(2);
    }
    process.stdout.write(`[nyx pipeline] ${result.message}\n`);
    process.stdout.write(`  run \`nyx tick\` to resume now, or wait for the next tick.\n`);
    return;
  }

  process.stderr.write(`nyx pipeline: unknown subcommand '${sub}'\n`);
  usage();
  process.exit(64);
}

main();

/**
 * Action executor — drains `pending_actions` each tick and applies each one
 * through injected dependencies (so the real wiring is in run-once and the
 * pure logic is testable). See docs/plugin-architecture.md.
 */
import { audit } from '../audit.js';
import { listPending, markApplied, markFailed, type PendingAction } from './db.js';

export interface ActionDeps {
  queueTask: (params: Record<string, unknown>) => string;
  resumeTask: (params: Record<string, unknown>) => string;
  pipelineDecision: (params: Record<string, unknown>) => string;
}

/**
 * Action kinds drained by dedicated pre-phases in run-once
 * (processDecomposeActions / processComposeTemplateActions), not by the
 * generic drain. A row enqueued MID-tick — after its pre-phase already ran but
 * before drainPendingActions — must stay pending for the next tick, not be
 * marked failed as an unknown action.
 */
export const PRE_PHASE_ACTIONS: ReadonlySet<string> = new Set(['decompose_task', 'compose_template']);

/** Insert a raw task block under the `## Active Tasks` header (pure). */
export function insertUnderActiveTasks(content: string, raw: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^##\s+Active Tasks\s*$/i.test(l));
  if (idx === -1) {
    return `${content.replace(/\n*$/, '\n')}\n## Active Tasks\n\n${raw.trim()}\n`;
  }
  lines.splice(idx + 1, 0, '', raw.trim());
  return lines.join('\n');
}

export function executeAction(a: PendingAction, deps: ActionDeps): string {
  switch (a.action) {
    case 'queue_task':
      return deps.queueTask(a.params);
    case 'resume_task':
      return deps.resumeTask(a.params);
    case 'pipeline_decision':
      return deps.pipelineDecision(a.params);
    case 'force_tick':
      return 'tick requested';
    default:
      throw new Error(`unknown action: ${a.action as string}`);
  }
}

export function drainPendingActions(deps: ActionDeps, now: () => number): number {
  let applied = 0;
  for (const a of listPending()) {
    if (PRE_PHASE_ACTIONS.has(a.action)) continue;
    try {
      const result = executeAction(a, deps);
      markApplied(a.id, result, now());
      audit('control.action.applied', 'control', { id: a.id, action: a.action, source: a.source });
      applied++;
    } catch (err) {
      markFailed(a.id, (err as Error).message, now());
      audit('control.action.failed', 'control', {
        id: a.id,
        action: a.action,
        source: a.source,
        error: (err as Error).message,
      });
    }
  }
  return applied;
}

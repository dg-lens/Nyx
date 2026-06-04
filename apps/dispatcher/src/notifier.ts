import { WebClient } from '@slack/web-api';

import { config } from './config.js';
import { emitHook } from './plugins/hooks.js';

let cached: WebClient | null = null;

/**
 * Master switch. Production leaves it on. Tests call `_setNotificationsEnabled(false)`
 * so exercising notify-firing code paths (e.g. the pipeline orchestrator's gate
 * pings) never hits the real Slack API — otherwise `pnpm test` DMs the operator.
 */
let notificationsEnabled = true;
export function _setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled = enabled;
}

function client(): WebClient | null {
  if (!config.slackBotToken) return null;
  if (!cached) cached = new WebClient(config.slackBotToken);
  return cached;
}

async function postViaWebhook(text: string): Promise<boolean> {
  if (!config.slackWebhookUrl) return false;
  try {
    const res = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function dm(text: string): Promise<void> {
  if (!notificationsEnabled) {
    console.log(`[notifier:disabled] ${text}`);
    return;
  }
  const c = client();
  if (c && config.slackUserId) {
    try {
      const open = await c.conversations.open({ users: config.slackUserId });
      const channel = open.channel?.id;
      if (channel) {
        await c.chat.postMessage({ channel, text });
        return;
      }
    } catch (err) {
      console.error('[notifier] slack DM failed:', err);
    }
  }
  if (await postViaWebhook(text)) return;
  console.log(`[notifier:no-slack] ${text}`);
}

export async function taskDispatched(taskId: string, type: string, model: string, gate: string): Promise<void> {
  await dm(`▶ Picking up ${taskId} (${type}, ${model}, gate: ${gate})`);
}

export async function taskCompleted(taskId: string, durationMin: number, gateSummary: string, finalize: string): Promise<void> {
  await dm(`✅ ${taskId} shipped. ${durationMin} min, ${gateSummary}. ${finalize}`);
}

export async function taskFailed(taskId: string, stage: string, snippet: string): Promise<void> {
  const log = snippet.slice(0, 500);
  await dm(`❌ ${taskId} failed at ${stage}. Failure: ${log}\nWorktree preserved.`);
}

export async function taskAbandoned(taskId: string, lastFailure: string): Promise<void> {
  await dm(`⛔ ${taskId} abandoned after 3 failures. Last failure: ${lastFailure.slice(0, 500)}`);
}

/**
 * v0.7: emit a high-urgency Slack alert when the audit phase halts a task.
 * The operator needs to act — the chain stays blocked until `nyx resume`.
 */
export async function taskHalted(
  taskId: string,
  pattern: string | undefined,
  report: string,
): Promise<void> {
  const head = pattern ? `🛑 *${taskId}* halted (${pattern})` : `🛑 *${taskId}* halted for review`;
  const tail = `\n\nTo unblock:\n  \`nyx resume ${taskId}\``;
  await dm(`${head}\n\n${report.slice(0, 1500)}${tail}`);
}

export async function taskAmbiguityEscalated(taskId: string, report: string): Promise<void> {
  const head = `❓ *${taskId}* needs a design decision before it can proceed`;
  const tail = `\n\nReply in the decision context, then:\n  \`nyx resume ${taskId}\``;
  await dm(`${head}\n\n${report.slice(0, 1500)}${tail}`);
}

export async function prCreated(taskId: string, prUrl: string): Promise<void> {
  await dm(`📬 ${taskId} → PR opened: ${prUrl}`);
}

/** A pipeline task was picked up and a run started (planning begins next). */
export async function pipelineRunStarted(runId: string, taskId: string, repo: string | null): Promise<void> {
  await dm(`▶ *${taskId}* — pipeline run started (run \`${runId}\`${repo ? ` · ${repo}` : ''}). Planning now.`);
}

/** An operator gate decision was received; the run is resuming (or stopping). */
export async function pipelineResumed(
  runId: string,
  taskId: string,
  gate: 'preview' | 'review',
  kind: string,
): Promise<void> {
  const verb = kind === 'abort' ? 'aborting' : kind === 'revise' || kind === 'rollback' ? 're-planning' : 'resuming';
  await dm(`▶ *${taskId}* — ${gate} decision \`${kind}\` received; ${verb} (run \`${runId}\`).`);
}

/** Terminal delivery — PR-ready + gate-green. */
export async function pipelineDelivered(
  runId: string,
  taskId: string,
  prUrl: string | null,
  deployTargets: string[],
): Promise<void> {
  const where = prUrl ? `PR (review + merge): ${prUrl}` : 'PR-ready on the integration branch';
  const deploy = deployTargets.length ? `\n⚠️ Manual deploy: ${deployTargets.join(', ')}.` : '';
  await dm(`✅ *${taskId}* — pipeline delivered (run \`${runId}\`). ${where}. Deploy is your manual step.${deploy}`);
}

/**
 * Pipeline run reached a human gate. Alert only — the decision is made via the
 * CLI (`nyx pipeline …`). The message lists the actual, copy-pasteable
 * commands for this gate. (The portal approval UI is not built yet, so this
 * deliberately does NOT link the portal — adding it back is part of the portal
 * `pipeline_decision` work; see [T5 scaffold/prompt-to-product-pipeline.md].)
 */
export async function pipelineAwaitingGate(
  runId: string,
  taskId: string,
  gate: 'preview' | 'review',
  summary: string,
): Promise<void> {
  await emitHook('pipeline.gateReached', { runId, taskId, gate, summary });
  const icon = gate === 'preview' ? '◧' : '◨';
  // Concrete, runnable commands — one per decision, not a `<a|b|c>` placeholder.
  const cmds =
    gate === 'preview'
      ? [
          `nyx pipeline go ${runId}`,
          `nyx pipeline revise ${runId} --note "..."`,
          `nyx pipeline abort ${runId}`,
        ]
      : [
          `nyx pipeline proceed ${runId}`,
          `nyx pipeline fix ${runId} --note "..."`,
          `nyx pipeline rollback ${runId}`,
          `nyx pipeline abort ${runId}`,
        ];
  await dm(
    `${icon} *${taskId}* — ${gate} gate reached (run \`${runId}\`).\n` +
      `${summary}\n` +
      `Brief: \`nyx pipeline status ${runId}\`\n\n` +
      `Decide (then \`nyx tick\` to resume now):\n` +
      '```\n' +
      cmds.join('\n') +
      '\n```',
  );
}

export async function claudeCrashed(taskId: string, exitCode: number, stderr: string): Promise<void> {
  const tail = stderr.trim() ? stderr.trim().slice(-500) : 'empty';
  await dm(`⚠️ Claude exited code ${exitCode} on ${taskId}. Stderr: ${tail}`);
}

export async function queueIdle(): Promise<void> {
  await dm(`🟢 All tasks checked. Queue idle.`);
}

export async function queueStale(hours: number): Promise<void> {
  await dm(`🟡 No successful task in ${hours} hours.`);
}

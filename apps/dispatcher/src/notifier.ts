import { WebClient } from '@slack/web-api';

import { audit } from './audit.js';
import { config } from './config.js';
import { emitHook } from './plugins/hooks.js';
import { CATEGORY_PRIORITY, shouldDeliver } from './notification-policy.js';
import {
  batchDigestItem,
  clearDigestBatch,
  formatDigest,
  pendingDigestItems,
} from './notification-digest.js';
import { redactCredentialPatterns } from './redaction.js';
import type { NotificationCategory } from './settings.js';

let cached: WebClient | null = null;

/**
 * Names of env vars whose values are secrets and may be injected into spawned
 * subprocesses (BWS_ACCESS_TOKEN + per-project Bitwarden secrets, the Anthropic
 * key, git/Slack tokens). When any of these has a value present in process.env,
 * that exact value is scrubbed from outbound notifier text. Match is a prefix
 * test so e.g. SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL are covered by `SLACK_`.
 */
const SECRET_ENV_PREFIXES = [
  'BWS_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'MARKETING_OS_ANTHROPIC_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'SLACK_',
  'OPENAI_API_KEY',
];

/**
 * Scrub secret values out of any text headed for Slack or an audit log. Two
 * passes: (1) exact-match the live values of every injected secret env var, so a
 * subprocess that echoes its env (set -x, a stack trace, a tool dumping
 * process.env) can't leak them; (2) pattern-match well-known secret token
 * shapes (sk-ant-…, github_pat_…, ghp_…, xoxb-…, AKIA…) via the shared
 * `redactCredentialPatterns` backstop for secrets not in this process's env —
 * including GitHub's default fine-grained `github_pat_` PATs a subprocess may
 * echo. Always call this before slicing/DM/audit of subprocess output.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    const isSecret = SECRET_ENV_PREFIXES.some((p) =>
      p.endsWith('_') ? name.startsWith(p) : name === p,
    );
    if (!isSecret) continue;
    out = out.split(value).join('[REDACTED]');
  }
  return redactCredentialPatterns(out);
}

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
  if (!config.settings.pipeline.slackNotifications) return null;
  if (!config.slackBotToken) return null;
  if (!cached) cached = new WebClient(config.slackBotToken);
  return cached;
}

async function postViaWebhook(text: string): Promise<boolean> {
  if (!config.settings.pipeline.slackNotifications) return false;
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

/**
 * Post one message to Slack (bot DM first, webhook fallback). Returns true if it
 * reached Slack. This is the original `dm()` body, extracted so `deliver()` can
 * fan out to it as one channel among several.
 */
async function postToSlack(text: string): Promise<boolean> {
  const c = client();
  if (c && config.slackUserId) {
    try {
      const open = await c.conversations.open({ users: config.slackUserId });
      const channel = open.channel?.id;
      if (channel) {
        await c.chat.postMessage({ channel, text });
        return true;
      }
    } catch (err) {
      console.error('[notifier] slack DM failed:', err);
    }
  }
  return postViaWebhook(text);
}

/**
 * Post one threaded reply into a specific channel via the bot WebClient — the
 * contact-surface outbound. Member replies land in the member↔bot DM, where the
 * bot identity is the only Nyx-side participant; no webhook fallback (a webhook
 * posts to its one fixed channel, never the member's DM).
 */
async function postToSlackThread(channelId: string, threadTs: string, text: string): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
    return true;
  } catch (err) {
    console.error('[notifier] slack thread reply failed:', redactSecrets(String(err)));
    return false;
  }
}

/**
 * Whether Pushover is usable: enabled in settings AND both creds present. Empty
 * creds disable the channel regardless of the settings flag (plan decision #4),
 * so a half-configured install silently no-ops Pushover instead of erroring.
 */
function pushoverEnabled(): boolean {
  return (
    config.settings.notifications.channels.pushover.enabled &&
    !!config.pushoverUserKey &&
    !!config.pushoverAppToken
  );
}

/**
 * Post one message to Pushover with the category's native priority. Returns true
 * on a 2xx. Tokens are kept out of any thrown/logged text via redactSecrets.
 * Uses the global fetch (Node 18+); no SDK dependency.
 */
async function postToPushover(category: NotificationCategory, text: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.pushoverAppToken,
        user: config.pushoverUserKey,
        message: text,
        priority: CATEGORY_PRIORITY[category],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[notifier] pushover post failed:', redactSecrets(String(err)));
    return false;
  }
}

/**
 * Sink indirection so routing tests can capture which channels fired without
 * hitting the real Slack/Pushover APIs. Production uses the real sinks; tests
 * swap them via `_setSinksForTest` and restore with `_resetSinksForTest`.
 */
type SlackSink = (text: string) => Promise<boolean>;
type PushoverSink = (category: NotificationCategory, text: string) => Promise<boolean>;
type ThreadReplySink = (channelId: string, threadTs: string, text: string) => Promise<boolean>;
let slackSink: SlackSink = postToSlack;
let pushoverSink: PushoverSink = postToPushover;
let threadReplySink: ThreadReplySink = postToSlackThread;
export function _setSinksForTest(sinks: {
  slack?: SlackSink;
  pushover?: PushoverSink;
  threadReply?: ThreadReplySink;
}): void {
  if (sinks.slack) slackSink = sinks.slack;
  if (sinks.pushover) pushoverSink = sinks.pushover;
  if (sinks.threadReply) threadReplySink = sinks.threadReply;
}
export function _resetSinksForTest(): void {
  slackSink = postToSlack;
  pushoverSink = postToPushover;
  threadReplySink = postToSlackThread;
}

/**
 * Contact surface: deliver a composed member reply in-thread over the SAME
 * bot-token Slack path every operator notification uses. The Slack MCP runs as
 * the operator's own user identity, which is NOT a participant in a member↔bot
 * DM — chat.postMessage from a non-participant fails (not_in_channel) — so
 * member replies MUST go through this bot client. Returns true only if the
 * message reached Slack; callers treat false as a delivery failure, never as
 * sent.
 */
export async function postSlackThreadReply(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  if (!notificationsEnabled) {
    console.log(`[notifier:disabled] thread reply → ${channelId}`);
    return false;
  }
  return threadReplySink(channelId, threadTs, redactSecrets(text));
}

/**
 * Fan one message out to every ENABLED channel right now. Slack is gated on the
 * settings flag; Pushover on its flag + creds. When neither channel is
 * configured (no creds, default Pushover-off, Slack token absent) this falls
 * back to a console log — identical to the pre-refactor `dm()` no-slack path, so
 * an install with no notifications config behaves exactly as before. Returns
 * true if the message reached at least one channel (used by the flush path to
 * decide whether the batch may be cleared).
 */
async function sendNow(category: NotificationCategory, text: string): Promise<boolean> {
  let reached = false;
  if (config.settings.notifications.channels.slack && (await slackSink(text))) reached = true;
  if (pushoverEnabled() && (await pushoverSink(category, text))) reached = true;
  if (!reached) {
    console.log(`[notifier:undelivered] ${text}`);
    // Surface the miss in the audit chain (once per sendNow, never per sink, and
    // only on a total miss — a working sink returns early above). Excerpt is
    // redacted + truncated so the chain never carries full message text or a
    // leaked secret. Wrapped so an audit-write failure can't throw out of deliver().
    try {
      audit('notification.undelivered', 'notifier', {
        category,
        text_excerpt: redactSecrets(text).slice(0, 200),
      });
    } catch (err) {
      console.error('[notifier] audit notification.undelivered failed:', err);
    }
  }
  return reached;
}

/**
 * Category-aware router with the LIVE Workflow gate (Track 6, N4). For each typed
 * event, `shouldDeliver(category, settings, now)` decides whether the operator is
 * reachable right now under the per-category policy:
 *   - deliver → fan out to the enabled channels immediately (today's behavior).
 *   - suppress → the message is BATCHED into the durable digest store, never
 *     dropped (plan decision #1). At the next working-window start the tick calls
 *     `flushDigest()` to send a single "what you missed" summary and clear it.
 *
 * `off`-policy categories are the one suppression that is a true drop, not a
 * defer: `shouldDeliver` reports `deliver:false` for both `off` and `digest`/
 * off-hours, so we distinguish them here — `off` means "never want this", so it
 * is neither sent nor batched.
 */
export async function deliver(category: NotificationCategory, text: string): Promise<void> {
  if (!notificationsEnabled) {
    console.log(`[notifier:disabled] ${text}`);
    return;
  }
  const decision = shouldDeliver(category, config.settings, new Date());
  if (decision.deliver) {
    await sendNow(category, text);
    return;
  }
  // Suppressed. `off` is a real drop (operator opted out of the category);
  // every other suppression is a defer — batch it for the next-window flush.
  if (config.settings.notifications.categories[category] === 'off') {
    console.log(`[notifier:off] ${text}`);
    return;
  }
  batchDigestItem(category, text);
  audit('notification.digest.batched', 'notifier', { category });
}

/**
 * Send the batched "what you missed" summary and clear the batch. Called by the
 * tick at the rising edge of `isWorkflowActive` (a scheduled window opening OR a
 * manual override being armed). No-op when the batch is empty. The batch is
 * cleared only if the summary reached a channel — a failed send leaves items
 * batched so the next tick retries rather than silently losing them. Returns the
 * number of items flushed (0 if nothing pending / send failed).
 */
export async function flushDigest(): Promise<number> {
  if (!notificationsEnabled) return 0;
  const items = pendingDigestItems();
  if (items.length === 0) return 0;
  const summary = formatDigest(items, config.systemName);
  // The digest is an action-required-adjacent catch-up the operator asked to see
  // on return; send it at `status` priority (0) so Pushover treats it as a normal
  // notification rather than a quiet-hours bypass.
  const reached = await sendNow('status', summary);
  if (!reached) return 0;
  clearDigestBatch();
  audit('notification.digest.flushed', 'notifier', { count: items.length });
  return items.length;
}

/**
 * Generic Slack-only sink, kept for callers that want a raw operator DM with no
 * category semantics. Typed events should route through `deliver(category, …)`.
 */
export async function dm(text: string): Promise<void> {
  if (!notificationsEnabled) {
    console.log(`[notifier:disabled] ${text}`);
    return;
  }
  if (config.settings.notifications.channels.slack && (await postToSlack(text))) return;
  console.log(`[notifier:no-slack] ${text}`);
}

export async function taskDispatched(taskId: string, type: string, model: string, gate: string): Promise<void> {
  await deliver('status', `▶ Picking up ${taskId} (${type}, ${model}, gate: ${gate})`);
}

export async function taskCompleted(taskId: string, durationMin: number, gateSummary: string, finalize: string): Promise<void> {
  await deliver('status', `✅ ${taskId} shipped. ${durationMin} min, ${gateSummary}. ${finalize}`);
}

export async function taskFailed(taskId: string, stage: string, snippet: string): Promise<void> {
  const log = redactSecrets(snippet).slice(0, 500);
  await deliver('failure', `❌ ${taskId} failed at ${stage}. Failure: ${log}\nWorktree preserved.`);
}

export async function taskAbandoned(taskId: string, lastFailure: string): Promise<void> {
  await deliver('failure', `⛔ ${taskId} abandoned after 3 failures. Last failure: ${redactSecrets(lastFailure).slice(0, 500)}`);
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
  await deliver('action-required', `${head}\n\n${redactSecrets(report).slice(0, 1500)}${tail}`);
}

export async function taskAmbiguityEscalated(taskId: string, report: string): Promise<void> {
  const head = `❓ *${taskId}* needs a design decision before it can proceed`;
  const tail = `\n\nReply in the decision context, then:\n  \`nyx resume ${taskId}\``;
  await deliver('action-required', `${head}\n\n${redactSecrets(report).slice(0, 1500)}${tail}`);
}

/**
 * Finding G-C: the gate passed, but the agent's diff touched gate-controlling
 * test-infra (conftest.py, jest/vitest config, CI workflow, package.json
 * scripts). Non-blocking — the task still completed. The operator should
 * eyeball the flagged paths to confirm the green verdict was earned, not steered.
 */
export async function taskGateTestInfraTouched(taskId: string, paths: string[]): Promise<void> {
  const list = paths.slice(0, 20).map((p) => `  • ${p}`).join('\n');
  await dm(
    `🧪 *${taskId}* passed the gate, but its diff touched test-infra files — review for gate-trust:\n${list}`,
  );
}

/**
 * P7 rotten-green: changed test files that assert nothing / are skip-only / sink
 * their result into a blank identifier. Advisory — the task still completed; the
 * operator should confirm the new tests actually check something.
 */
export async function taskRottenGreen(taskId: string, lines: string[]): Promise<void> {
  const list = lines.slice(0, 20).map((l) => `  • ${l}`).join('\n');
  await dm(
    `🪫 *${taskId}* passed the gate, but its new/changed tests look rotten-green (assert nothing / skip-only):\n${list}`,
  );
}

/**
 * P7 content-judge: an independent read-only spawn scored the diff a confident
 * FAIL against the task's acceptance criteria. Advisory — the task still
 * completed (the judge is same-family, so it can't fail the task), but the diff
 * may not actually do what was asked.
 */
export async function taskJudgeConcern(taskId: string, summary: string): Promise<void> {
  await dm(
    `🧑‍⚖️ *${taskId}* passed the gate, but the content-judge flagged it: ${redactSecrets(summary).slice(0, 500)}`,
  );
}

export async function prCreated(taskId: string, prUrl: string): Promise<void> {
  await deliver('delivery', `📬 ${taskId} → PR opened: ${prUrl}`);
}

/** A pipeline task was picked up and a run started (planning begins next). */
export async function pipelineRunStarted(runId: string, taskId: string, repo: string | null): Promise<void> {
  await deliver('status', `▶ *${taskId}* — pipeline run started (run \`${runId}\`${repo ? ` · ${repo}` : ''}). Planning now.`);
}

/** An operator gate decision was received; the run is resuming (or stopping). */
export async function pipelineResumed(
  runId: string,
  taskId: string,
  gate: 'preview' | 'review',
  kind: string,
): Promise<void> {
  const verb = kind === 'abort' ? 'aborting' : kind === 'revise' || kind === 'rollback' ? 're-planning' : 'resuming';
  await deliver('status', `▶ *${taskId}* — ${gate} decision \`${kind}\` received; ${verb} (run \`${runId}\`).`);
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
  await deliver('delivery', `✅ *${taskId}* — pipeline delivered (run \`${runId}\`). ${where}. Deploy is your manual step.${deploy}`);
}

/**
 * Pipeline run reached a human gate. Alert only — the decision is made via the
 * CLI (`nyx pipeline …`). The message lists the actual, copy-pasteable
 * commands for this gate. (The portal approval UI is not built yet, so this
 * deliberately does NOT link the portal — adding it back is part of the portal
 * `pipeline_decision` work; see the moc-nyx-pipeline node.)
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
  await deliver(
    'action-required',
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
  const scrubbed = redactSecrets(stderr).trim();
  const tail = scrubbed ? scrubbed.slice(-500) : 'empty';
  await deliver('failure', `⚠️ Claude exited code ${exitCode} on ${taskId}. Stderr: ${tail}`);
}

export async function queueIdle(): Promise<void> {
  await deliver('status', `🟢 All tasks checked. Queue idle.`);
}

export async function queueStale(hours: number): Promise<void> {
  await deliver('status', `🟡 No successful task in ${hours} hours.`);
}

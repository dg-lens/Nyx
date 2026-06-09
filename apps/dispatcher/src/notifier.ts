import { WebClient } from '@slack/web-api';

import { config } from './config.js';
import { emitHook } from './plugins/hooks.js';
import { CATEGORY_PRIORITY } from './notification-policy.js';
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
let slackSink: SlackSink = postToSlack;
let pushoverSink: PushoverSink = postToPushover;
export function _setSinksForTest(sinks: { slack?: SlackSink; pushover?: PushoverSink }): void {
  if (sinks.slack) slackSink = sinks.slack;
  if (sinks.pushover) pushoverSink = sinks.pushover;
}
export function _resetSinksForTest(): void {
  slackSink = postToSlack;
  pushoverSink = postToPushover;
}

/**
 * Category-aware router: fan one message out to every ENABLED channel. Slack is
 * gated on the settings flag; Pushover on its flag + creds. When neither channel
 * is configured (no creds, default Pushover-off, Slack token absent) this falls
 * back to a console log — identical to the pre-refactor `dm()` no-slack path, so
 * an install with no notifications config behaves exactly as before.
 *
 * NOTE (Track 6 scope): this does NOT yet apply `shouldDeliver`/Workflow-mode
 * suppression. The pure policy helpers ship in this phase (schema + helpers),
 * but suppression is wired only once the off-hours digest (N4) exists — otherwise
 * suppressed messages would be silently dropped rather than batched.
 */
export async function deliver(category: NotificationCategory, text: string): Promise<void> {
  if (!notificationsEnabled) {
    console.log(`[notifier:disabled] ${text}`);
    return;
  }
  let reached = false;
  if (config.settings.notifications.channels.slack && (await slackSink(text))) reached = true;
  if (pushoverEnabled() && (await pushoverSink(category, text))) reached = true;
  if (!reached) console.log(`[notifier:undelivered] ${text}`);
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

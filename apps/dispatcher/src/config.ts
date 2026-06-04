import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function expandUser(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ENV_FILE = resolve(ROOT, '.env');

if (existsSync(ENV_FILE)) {
  loadEnv({ path: ENV_FILE });
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const config = {
  root: ROOT,
  queuePath: resolve(ROOT, 'nyx.md'),
  dbPath: resolve(ROOT, 'data', 'nyx.db'),
  logsDir: resolve(ROOT, 'logs'),
  outputsDir: resolve(ROOT, 'outputs'),
  worktreesDir: resolve(ROOT, 'worktrees'),
  contextDir: resolve(ROOT, 'context'),

  lockfilePath: '/tmp/nyx-dispatch.lock',
  finalizeSentinelPath: '/tmp/nyx-finalize-in-progress.json',
  cloneRootPrefix: '/tmp/nyx-clone-',

  slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
  slackUserId: process.env.SLACK_USER_ID ?? '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  operatorName: process.env.OPERATOR_NAME ?? 'Operator',

  // System identity. `NAME` (set in .env — the first var) is the configurable
  // name of this agent instance; rename your install by changing it. Consumers
  // (prompts, notifications, dashboard) should read `config.systemName` rather
  // than hardcoding "Nyx".
  systemName: process.env.NAME ?? 'Nyx',

  // Git author identity for commits Nyx makes during code tasks. Set these in
  // .env to YOUR real, GitHub-linked name + email — otherwise commits won't
  // attribute to your account, and some CI providers (Vercel commit-author SSO,
  // GitHub Actions on PR-branch pushes) may reject or silently ignore commits
  // authored as a non-account address.
  gitAuthorName: process.env.GIT_AUTHOR_NAME ?? 'Nyx Agent',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? 'nyx@localhost',

  /**
   * Per-repo overrides for what branch Nyx targets and whether it opens a
   * PR or pushes directly. Default behavior (when a repo isn't listed below):
   * - baseBranch: detected from origin/HEAD (usually `main`)
   * - pushMode: `pr` — opens a PR via gh and enables auto-merge
   *
   * For repos that have branch protection on main + a dedicated integration
   * branch like `dev`, set `pushMode: 'direct'` so the dispatcher pushes
   * straight to the integration branch after rebasing. No PR is opened; main
   * stays protected behind the operator-driven dev → main promotion flow.
   *
   * Source of truth for now: this hard-coded map. If the operator surface for
   * this needs to grow, move into the bitwarden_projects table or a JSON
   * config file. Hard-coded is fine for the current scope (single operator,
   * known repo list).
   */
  /**
   * `deployPatterns` — path prefixes (relative to repo root) that signal a file
   * requires a manual production deploy step after Nyx pushes. E.g. changes
   * under `apps/marketing-api/` need a `fly deploy` in that sub-app. When a code
   * task's diff contains any file matching one of these prefixes, Nyx emits
   * `task.production.deploy_required` into the audit chain so the operator knows
   * production is now out-of-date even though the task completed successfully.
   *
   * `deployTargets` — human-readable labels for the deploy surfaces that need
   * attention (e.g. `'Fly: my-service'`). Included in the audit payload
   * so the portal can surface actionable guidance without the operator having to
   * cross-reference the codebase.
   */
  gitTargets: {} as Record<
    string,
    { baseBranch: string; pushMode: 'pr' | 'direct'; deployPatterns?: string[]; deployTargets?: string[] } | undefined
  >,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  githubToken: process.env.GITHUB_TOKEN ?? '',

  autoChain: bool('AUTO_CHAIN', true),
  maxChainDepth: int('MAX_CHAIN_DEPTH', 2),
  // Pipeline (`[type: pipeline]`) — max coders running concurrently in the
  // executing stage. Start at 4; raising it as rate-limit behavior is observed
  // is essential (see scaffold/prompt-to-product-pipeline.md). Each coder runs
  // in its own git worktree off the integration base.
  pipelineCoderConcurrency: int('PIPELINE_CODER_CONCURRENCY', 4),
  dispatchIntervalMinutes: int('DISPATCH_INTERVAL_MINUTES', 15),
  logRetentionDays: int('LOG_RETENTION_DAYS', 7),
  gateStageTimeoutMs: int('GATE_STAGE_TIMEOUT_MS', 5 * 60_000),
  claudeTaskTimeoutMs: int('CLAUDE_TASK_TIMEOUT_MS', 30 * 60_000),
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE ?? 'acceptEdits',
  auditFailureLogMinBytes: int('AUDIT_FAILURE_LOG_MIN_BYTES', 8192),

  // ── Bitwarden Secrets Manager (v0.5) ──
  // Optional. The dispatcher tolerates a missing machine token (logs a warning
  // and continues) — Bitwarden is only required for tasks that opt-in via
  // [bw-project: <name>] or a registered repo-to-project mapping.
  bitwardenMachineTokenPath: expandUser(
    process.env['BITWARDEN_MACHINE_TOKEN_PATH'] ?? '~/.config/bitwarden/nyx-machine.token',
  ),
  bitwardenAdminCredsPath: expandUser(
    process.env['BITWARDEN_ADMIN_CREDS_PATH'] ?? '~/.config/bitwarden/nyx-admin.json',
  ),
  bitwardenDefaultRotationDays: int('BITWARDEN_DEFAULT_ROTATION_DAYS', 90),
  bitwardenOrganizationId: process.env['BITWARDEN_ORGANIZATION_ID'] ?? '',
  bitwardenApiBase: (process.env['BITWARDEN_API_BASE'] ?? 'https://api.bitwarden.com').replace(/\/+$/, ''),
  bitwardenInboxDir: resolve(ROOT, 'inbox', 'rotation-events'),
} as const;

export type Config = typeof config;

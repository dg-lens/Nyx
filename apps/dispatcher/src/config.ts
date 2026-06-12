import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadSettings } from './settings.js';

function expandUser(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

const REPO_ROOT = process.env['NYX_REPO_ROOT']
  ? expandUser(process.env['NYX_REPO_ROOT'])
  : resolve(import.meta.dirname, '..', '..', '..');
const DATA_DIR = process.env['NYX_DATA_DIR']
  ? expandUser(process.env['NYX_DATA_DIR'])
  : existsSync(resolve(REPO_ROOT, '..', 'Data'))
    ? resolve(REPO_ROOT, '..', 'Data')
    : REPO_ROOT;
const PLUGINS_DIR = process.env['NYX_PLUGINS_DIR']
  ? expandUser(process.env['NYX_PLUGINS_DIR'])
  : resolve(REPO_ROOT, '..', 'Plugins');

const ENV_FILE = resolve(DATA_DIR, '.env');
if (existsSync(ENV_FILE)) {
  loadEnv({ path: ENV_FILE });
}

const SETTINGS = loadSettings(DATA_DIR);

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

const APPS_DIR = process.env['NYX_APPS_DIR']
  ? expandUser(process.env['NYX_APPS_DIR'])
  : resolve(homedir(), 'Nyx', 'Apps');

// Test seam (mirrors git-ops._setWorktreesDir): lets unit tests exercising the
// durable app:<slug> destination point appsDir at a throwaway tmpdir instead of
// mutating the (readonly, `as const`) config object — and never touch the real
// ~/Nyx/Apps. `config.appsDir` is a getter so every consumer sees the override.
let appsDirOverride: string | null = null;
export function _setAppsDir(dir: string | null): void { appsDirOverride = dir; }

export const config = {
  root: REPO_ROOT,
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  pluginsDir: PLUGINS_DIR,
  stockPluginsDir: resolve(REPO_ROOT, 'plugins'),
  queuePath: resolve(DATA_DIR, 'nyx.md'),
  dbPath: resolve(DATA_DIR, 'data', 'nyx.db'),
  logsDir: resolve(DATA_DIR, 'logs'),
  outputsDir: resolve(DATA_DIR, 'outputs'),
  projectsDir: resolve(DATA_DIR, 'projects'),
  // Durable destination for `[repo: app:<slug>]` pipeline runs. Deliberately
  // OUTSIDE dataDir: a delivered app is an operator-facing standalone project,
  // not Nyx state. Override with NYX_APPS_DIR (operators) or _setAppsDir (tests).
  get appsDir(): string { return appsDirOverride ?? APPS_DIR; },
  worktreesDir: resolve(DATA_DIR, 'worktrees'),
  contextDir: resolve(DATA_DIR, 'context'),

  lockfilePath: '/tmp/nyx-dispatch.lock',
  // GIT-class single-flight mutex (code + pipeline). Held for the lifetime of a
  // GIT task's spawn+finalize so a `main()` invocation never starts a SECOND GIT
  // task (e.g. a resumed pipeline phase + a queued code task in one tick). NOTE:
  // it does NOT by itself yield cross-tick GIT/ISO overlap — the shell lock in
  // nyx-dispatch.sh serializes whole tick processes, so a later launchd tick
  // can't start while a long GIT task runs. See git-task-lock.ts for the full
  // scope. Distinct from lockfilePath (which serializes tick processes).
  gitTaskLockPath: '/tmp/nyx-git-task.lock',
  finalizeSentinelPath: '/tmp/nyx-finalize-in-progress.json',
  cloneRootPrefix: '/tmp/nyx-clone-',

  slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
  slackUserId: process.env.SLACK_USER_ID ?? '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  operatorName: process.env.OPERATOR_NAME ?? 'Operator',

  // ── Contact-surface inbound rate guard ──
  // A hostile/malfunctioning federation member flooding DMs would otherwise fan
  // out unbounded NYX-RESPOND tasks → unbounded paid spawns. respondMessage caps
  // accepted responds per member to `respondCapPerMember` within the trailing
  // `respondCapWindowMs`; excess is dropped with a `slack.ratelimited` audit event.
  // Coarse by design — a sane default that an operator can raise/lower via env.
  respondCapPerMember: Number(process.env.NYX_RESPOND_CAP_PER_MEMBER ?? 5),
  respondCapWindowMs: Number(process.env.NYX_RESPOND_CAP_WINDOW_MS ?? 3_600_000),

  // ── Pushover (optional second notification channel) ──
  // Bitwarden/env-backed, read like the Slack creds. Both empty → Pushover is
  // disabled regardless of the settings.notifications.channels.pushover flag.
  pushoverUserKey: process.env.PUSHOVER_USER_KEY ?? '',
  pushoverAppToken: process.env.PUSHOVER_APP_TOKEN ?? '',

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
  // `||` not `??`: a blank GIT_AUTHOR_NAME= in .env is an empty string, which `??`
  // would NOT replace — leaving git with an empty identity ("empty ident name").
  gitAuthorName: process.env.GIT_AUTHOR_NAME || 'Nyx Agent',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'nyx@localhost',

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
    {
      baseBranch: string;
      pushMode: 'pr' | 'direct';
      deployPatterns?: string[];
      deployTargets?: string[];
      /**
       * Linter versions pinned to the target repo's CI (P7 lint gate). The diff-
       * scoped lint stage installs and runs EXACTLY these versions so a local
       * green doesn't diverge from a CI red on a rule that shipped in a newer
       * linter. Keyed by tool; value is the exact version CI uses (e.g. ruff
       * `'0.6.9'`, eslint `'9.13.0'`). Absent → the gate falls back to the
       * version the repo itself declares, and records that it was unpinned.
       */
      lintPins?: { ruff?: string; eslint?: string };
    } | undefined
  >,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  githubToken: process.env.GITHUB_TOKEN ?? '',

  // Operator settings (Data/settings.json, written by the desktop Settings tab).
  // Exposed whole so consumers can read pipeline/dispatcher/plugin prefs; the
  // numeric ones below also fold into the existing config fields as defaults.
  settings: SETTINGS,

  autoChain: bool('AUTO_CHAIN', true),
  maxChainDepth: int('MAX_CHAIN_DEPTH', SETTINGS.dispatcher.maxChainDepth),
  // Pipeline (`[type: pipeline]`) — max coders running concurrently in the
  // executing stage. Start at 4; raising it as rate-limit behavior is observed
  // is essential (see moc-nyx-pipeline (Arachne)). Each coder runs
  // in its own git worktree off the integration base.
  pipelineCoderConcurrency: int('PIPELINE_CODER_CONCURRENCY', SETTINGS.pipeline.concurrentCap),
  // Type-aware concurrency (Track 3). maxConcurrentIso bounds the ISO pool
  // (analysis/assistant/content) one tick fills and drains; maxConcurrentClaude
  // is the aggregate live-spawn ceiling across BOTH classes (the one GIT task's
  // spawn + a pipeline's internal coders + the ISO pool) so the shared Max-plan
  // OAuth quota is never blown. effectiveIsoCap = min(maxConcurrentIso,
  // maxConcurrentClaude - liveOwnClaudeCount()). Conservative defaults; raise as
  // dispatch.rate_limited telemetry shows headroom.
  maxConcurrentIso: int('MAX_CONCURRENT_ISO', SETTINGS.dispatcher.maxConcurrentIso),
  maxConcurrentClaude: int('MAX_CONCURRENT_CLAUDE', SETTINGS.dispatcher.maxConcurrentClaude),
  // Cooldown applied after a 429/rate_limit/overloaded signal: NEW spawns are
  // suppressed (tasks stay queued, NOT failed) until the window passes. Used as
  // the fallback when the provider sends no Retry-After header.
  rateLimitCooldownMs: int('RATE_LIMIT_COOLDOWN_MS', 5 * 60_000),
  // Per-launch jitter when filling the ISO pool so N spawns don't hit the API in
  // the same instant and trip a burst limit. Each launch sleeps a random value
  // in [0, isoLaunchJitterMs).
  isoLaunchJitterMs: int('ISO_LAUNCH_JITTER_MS', 500),
  dispatchIntervalMinutes: int('DISPATCH_INTERVAL_MINUTES', 15),
  logRetentionDays: int('LOG_RETENTION_DAYS', 7),
  gateStageTimeoutMs: int('GATE_STAGE_TIMEOUT_MS', 5 * 60_000),
  claudeTaskTimeoutMs: int('CLAUDE_TASK_TIMEOUT_MS', SETTINGS.dispatcher.taskTimeoutMs),
  // Loop-detector heartbeat: kill a spawn that emits no stdout/stderr for this
  // long (likely a hung MCP/tool call) before the full wall-clock budget, with a
  // 'stalled' classification distinct from exit 124. 0 disables the watchdog.
  // DEFAULT OFF (0): `claude -p --output-format json` emits a single final blob,
  // not incremental stdout, so any positive default would false-kill legitimate
  // long-running code/coder spawns. The mechanism is kept intact and opt-in via
  // CLAUDE_SILENCE_TIMEOUT_MS — re-enable only once streaming output is verified,
  // and only above the 30-min task timeout if used as a coarse outer guard.
  claudeSilenceTimeoutMs: int('CLAUDE_SILENCE_TIMEOUT_MS', 0),
  // Per-spawn cost/token metering via `claude -p --output-format json`. On by
  // default; locally-estimated (works under Max-plan OAuth, no billing signal).
  costMeteringEnabled: bool('COST_METERING_ENABLED', true),
  // Content-judge (P7): a haiku Read/Grep-only spawn that scores a code task's
  // diff PASS/FAIL against its acceptance criteria after the gate passes.
  // Advisory + non-fatal — a FAIL flags for review, never fails the task. On by
  // default; free-ish under Max plan but it IS a spawn, so allow disabling.
  contentJudgeEnabled: bool('CONTENT_JUDGE_ENABLED', true),
  contentJudgeConfidenceThreshold: int('CONTENT_JUDGE_CONFIDENCE_THRESHOLD', 75),
  // Flaky-test quarantine (P7): on a gate tests-stage FAILURE, rerun the tests
  // stage once on the IDENTICAL tree. If the verdict flips → quarantine (halt),
  // never silently retry-to-green. On by default; the rerun is the only added
  // cost and only happens on an initial tests-stage failure.
  flakyRerunEnabled: bool('FLAKY_RERUN_ENABLED', true),
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
  bitwardenInboxDir: resolve(DATA_DIR, 'inbox', 'rotation-events'),

  // ── Composer layer ──
  // The composer is the pre-dispatch task-spec normalizer/compiler. Today the
  // normalizer runs in SHADOW MODE: it computes + persists + audit-logs its
  // verdict and returns control unchanged. It never halts, rejects, or alters
  // the spec the executor sees.
  composer: {
    normalizer: {
      // Compute the shadow normalization (LLM spawn + DAG compile + persist).
      // OFF by default: the normalizer is now wired into the live code-task
      // dispatch path, so a `true` default would silently add one extra sonnet
      // planning spawn to EVERY code task on merge. The operator opts in with
      // COMPOSER_NORMALIZER_ENABLED=true to begin shadow observation; the
      // shipped/default config runs nothing new. (Enforcement —
      // COMPOSER_NORMALIZER_ENFORCED below — is a separate future flag.)
      enabled: bool('COMPOSER_NORMALIZER_ENABLED', false),
      // Future enforcement flag. DEFAULT FALSE and NOT acted on anywhere in this
      // cut — it is recorded on each NormalizationResult for operator visibility
      // only. Turning it into a runtime gate is a SEPARATE future PR.
      enforced: bool('COMPOSER_NORMALIZER_ENFORCED', false),
    },
  },
} as const;

// Force a non-empty git identity into the environment every `git` child inherits.
// nyx-dispatch.sh does `set -a; source .env`, so a blank `GIT_AUTHOR_NAME=` in .env
// is EXPORTED as an empty env var — and git prefers GIT_AUTHOR_NAME over user.name
// config, so an empty value yields "fatal: empty ident name". Pinning all four here
// (author + committer) makes a blank/absent .env identity impossible to hit.
process.env['GIT_AUTHOR_NAME'] = config.gitAuthorName;
process.env['GIT_AUTHOR_EMAIL'] = config.gitAuthorEmail;
process.env['GIT_COMMITTER_NAME'] = config.gitAuthorName;
process.env['GIT_COMMITTER_EMAIL'] = config.gitAuthorEmail;

export type Config = typeof config;

export function validateConfig(): void {
  const appsDir = config.appsDir;
  const clonePrefix = config.cloneRootPrefix;
  const projectsDir = config.projectsDir;

  const prefixOf = (a: string, b: string): boolean => a === b || a.startsWith(b + '/');

  if (appsDir.startsWith(clonePrefix)) {
    throw new Error(
      `Config error: appsDir (${appsDir}) must not overlap cloneRootPrefix (${clonePrefix}) or projectsDir (${projectsDir}). ` +
        `Set NYX_APPS_DIR to a distinct directory (default: ~/Nyx/Apps).`,
    );
  }
  if (prefixOf(appsDir, projectsDir) || prefixOf(projectsDir, appsDir)) {
    throw new Error(
      `Config error: appsDir (${appsDir}) must not overlap cloneRootPrefix (${clonePrefix}) or projectsDir (${projectsDir}). ` +
        `Set NYX_APPS_DIR to a distinct directory (default: ~/Nyx/Apps).`,
    );
  }
}

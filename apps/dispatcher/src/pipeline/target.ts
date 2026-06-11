/**
 * Pipeline target-mode classifier.
 *
 * A pipeline run's `repo` field decides where the work lands. There are four
 * valid shapes plus an error case:
 *
 *   - external   — `owner/name`     → clone https://github.com/owner/name.git, PR at delivery
 *   - self       — empty/null       → operate on ~/Nyx itself (a worktree)
 *   - greenfield — `local` (et al.) → scaffold a brand-new local project, no clone, no PR
 *   - app        — `app:<slug>`     → greenfield variant landing at a DURABLE, operator-named
 *                                     path: config.appsDir/<slug> instead of Data/projects/<task>.
 *                                     An existing destination is a hard refusal, never a merge.
 *   - invalid    — anything else    → a non-`owner/name` string that isn't a greenfield keyword
 *                                     or app tag; almost always a typo'd repo. Callers reject it loudly.
 *
 * Before greenfield existed, a `[repo: local]` task fell into the external path
 * and tried to `git clone https://github.com/local.git`, which 404s — the
 * failure this module fixes. Keep classification here so every setup site
 * (planning dir, integration base, delivery, cleanup) agrees.
 */

import { resolve } from 'node:path';

import { config } from '../config.js';

const GREENFIELD_SENTINELS = new Set(['local', 'new', 'greenfield', 'scratch']);
const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;
// Strictly lowercase `app:` + [a-z0-9-]+: the slug becomes a literal path segment
// under config.appsDir AND flows through the same C2 surface as OWNER_NAME, so the
// charset deliberately excludes dots, slashes, `~`, whitespace, and every shell
// metacharacter. An uppercase prefix/slug is a typo, not a different app — invalid.
const APP_TAG = /^app:([a-z0-9-]+)$/;

export type TargetMode = 'external' | 'self' | 'greenfield' | 'app' | 'invalid';

export function targetMode(repo: string | null | undefined): TargetMode {
  const r = (repo ?? '').trim();
  if (!r) return 'self';
  if (OWNER_NAME.test(r)) return 'external';
  if (GREENFIELD_SENTINELS.has(r.toLowerCase())) return 'greenfield';
  if (APP_TAG.test(r)) return 'app';
  return 'invalid';
}

export function isGreenfield(repo: string | null | undefined): boolean {
  return targetMode(repo) === 'greenfield';
}

/**
 * Greenfield-variant predicate: modes whose integration base IS the deliverable —
 * a durable local dir (Data/projects/<task> or appsDir/<slug>) that delivery's
 * brief points at and cleanup must NEVER delete. Delivery call sites use this,
 * not `isGreenfield`, so the app variant can't be treated as a disposable /tmp base.
 */
export function isGreenfieldVariant(repo: string | null | undefined): boolean {
  const m = targetMode(repo);
  return m === 'greenfield' || m === 'app';
}

/** The slug of an `app:<slug>` repo tag, or null for every other shape. */
export function appSlug(repo: string | null | undefined): string | null {
  const m = (repo ?? '').trim().match(APP_TAG);
  return m ? m[1]! : null;
}

/**
 * Scaffold destination for an app-mode run: config.appsDir/<slug>. The slug is
 * used VERBATIM (already constrained to [a-z0-9-]+) — never run it through a
 * task_id sanitizer, or the delivered path stops matching the operator's tag.
 * Throws on a non-app repo so a misrouted caller fails loudly, not at some
 * accidental path.
 */
export function appDestination(repo: string | null | undefined): string {
  const slug = appSlug(repo);
  if (!slug) throw new Error(`appDestination called with a non-app repo: ${repo}`);
  return resolve(config.appsDir, slug);
}

/**
 * A `[repo:]` tag value is acceptable for ANY task type iff it's an `owner/name`
 * GitHub repo, a greenfield keyword, or an `app:<slug>` tag. This is the primary
 * guard against shell command injection: an unvalidated repo string is
 * interpolated into `git clone` (see git-ops.cloneExternalRepo), so a value
 * bearing shell metacharacters (`"`, `;`, `$(…)`, backticks, spaces) would
 * execute arbitrary commands on the dispatcher host. `OWNER_NAME`/greenfield-
 * keyword/`APP_TAG` shapes contain none of those — the app slug's strict
 * [a-z0-9-]+ charset is what preserves the guarantee. Empty/absent repo (self
 * mode) is the caller's concern, not this predicate's.
 */
export function isValidRepoTag(repo: string): boolean {
  const m = targetMode(repo);
  return m === 'external' || m === 'greenfield' || m === 'app';
}

/** Human-facing reason for an `invalid` repo, used in the terminal-failure message. */
export function invalidRepoReason(repo: string | null | undefined): string {
  return (
    `pipeline [repo: ${repo}] is neither an "owner/name" GitHub repo, a greenfield ` +
    `keyword (${[...GREENFIELD_SENTINELS].join(' | ')}), nor an "app:<slug>" target. ` +
    `Use "owner/name" to target an existing repo, "local" to build a new local project, ` +
    `or "app:<slug>" (slug: [a-z0-9-]+) to scaffold a new app under ${config.appsDir}.`
  );
}

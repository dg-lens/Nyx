/**
 * Pipeline target-mode classifier.
 *
 * A pipeline run's `repo` field decides where the work lands. There are three
 * valid shapes plus an error case:
 *
 *   - external   — `owner/name`     → clone https://github.com/owner/name.git, PR at delivery
 *   - self       — empty/null       → operate on ~/Nyx itself (a worktree)
 *   - greenfield — `local` (et al.) → scaffold a brand-new local project, no clone, no PR
 *   - invalid    — anything else    → a non-`owner/name` string that isn't a greenfield keyword;
 *                                     almost always a typo'd repo. Callers reject it loudly.
 *
 * Before greenfield existed, a `[repo: local]` task fell into the external path
 * and tried to `git clone https://github.com/local.git`, which 404s — the
 * failure this module fixes. Keep classification here so every setup site
 * (planning dir, integration base, delivery, cleanup) agrees.
 */

const GREENFIELD_SENTINELS = new Set(['local', 'new', 'greenfield', 'scratch']);
const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;

export type TargetMode = 'external' | 'self' | 'greenfield' | 'invalid';

export function targetMode(repo: string | null | undefined): TargetMode {
  const r = (repo ?? '').trim();
  if (!r) return 'self';
  if (OWNER_NAME.test(r)) return 'external';
  if (GREENFIELD_SENTINELS.has(r.toLowerCase())) return 'greenfield';
  return 'invalid';
}

export function isGreenfield(repo: string | null | undefined): boolean {
  return targetMode(repo) === 'greenfield';
}

/**
 * A `[repo:]` tag value is acceptable for ANY task type iff it's an `owner/name`
 * GitHub repo or a greenfield keyword. This is the primary guard against shell
 * command injection: an unvalidated repo string is interpolated into `git clone`
 * (see git-ops.cloneExternalRepo), so a value bearing shell metacharacters
 * (`"`, `;`, `$(…)`, backticks, spaces) would execute arbitrary commands on the
 * dispatcher host. `OWNER_NAME`/greenfield-keyword shapes contain none of those.
 * Empty/absent repo (self mode) is the caller's concern, not this predicate's.
 */
export function isValidRepoTag(repo: string): boolean {
  const m = targetMode(repo);
  return m === 'external' || m === 'greenfield';
}

/** Human-facing reason for an `invalid` repo, used in the terminal-failure message. */
export function invalidRepoReason(repo: string | null | undefined): string {
  return (
    `pipeline [repo: ${repo}] is neither an "owner/name" GitHub repo nor a greenfield ` +
    `keyword (${[...GREENFIELD_SENTINELS].join(' | ')}). ` +
    `Use "owner/name" to target an existing repo, or "local" to build a new local project.`
  );
}

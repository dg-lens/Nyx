import { execSync } from 'node:child_process';

/**
 * Returns all files currently modified or new (untracked) in `workingDir`
 * without requiring a commit. Combines staged changes, unstaged changes, and
 * untracked files. Intended for doc-sweep verification before `commitAll`.
 *
 * Returns an empty array if git is unavailable or the dir is not a git repo.
 * Never throws.
 */
export function changedFilesWorkingTree(workingDir: string): string[] {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  };
  const lines = [
    run('git diff --name-only --cached'),
    run('git diff --name-only'),
    run('git ls-files --others --exclude-standard'),
  ]
    .join('\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

/**
 * Returns the list of files changed between `baseRef` and `HEAD` in the given
 * working dir. Runs `git diff --name-only <baseRef>..HEAD`.
 *
 * Returns an empty array if git is unavailable, the baseRef doesn't exist, or
 * the working dir is not a git repo. Never throws — callers treat an empty
 * result as "no changed files detected", which suppresses the
 * `task.production.deploy_required` event rather than falsely emitting it.
 *
 * @param workingDir  Absolute path to the git working dir (clone or worktree).
 * @param baseRef     The ref to diff against, e.g. `origin/dev` or `origin/main`.
 */
export function changedFiles(workingDir: string, baseRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only "${baseRef}"..HEAD`, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Pure pattern-match: returns which of the changed `files` match any of the
 * declared deploy-trigger `patterns`. Matching is prefix-based — a pattern of
 * `apps/marketing-api/` matches any file whose path starts with that string.
 * An exact match (pattern === file path) is also accepted.
 *
 * Returns `{ matchedFiles: string[] }`. If either argument is empty the result
 * is always `{ matchedFiles: [] }` — callers can safely skip emitting an audit
 * event without any additional guard.
 *
 * This function is intentionally pure (no I/O, no side-effects) so it can be
 * unit-tested without a real working dir.
 *
 * @param files     List of changed file paths (relative to repo root).
 * @param patterns  Deploy-trigger path prefixes (e.g. `['apps/marketing-api/', 'apps/outreach-api/']`).
 */
export function detectDeployRequired(
  files: string[],
  patterns: string[],
): { matchedFiles: string[] } {
  if (files.length === 0 || patterns.length === 0) {
    return { matchedFiles: [] };
  }
  const matchedFiles = files.filter(f =>
    patterns.some(p => f.startsWith(p) || f === p),
  );
  return { matchedFiles };
}

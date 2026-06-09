/**
 * The two-class split that the type-aware dispatcher is built on.
 *
 * GIT-class tasks ({@link TaskType} `code` + `pipeline`) touch git worktrees,
 * the shared `~/Nyx` repo (`git checkout main` / `git merge` / `git stash`), and
 * `git push` to shared branches. Two of them running at once corrupt each
 * other's index/working tree or race a non-fast-forward push, so AT MOST ONE
 * GIT task is live system-wide.
 *
 * ISO-class tasks (`analysis`, `assistant`, `content`) are read-only against the
 * repo or output-isolated (each finalizes by copying into its own
 * `outputs/<id>/` subtree or DMs the operator). They never touch `config.root`
 * or push, so they are mutually isolated AND isolated from the one in-flight GIT
 * task — they can run concurrently up to a cap.
 *
 * One source of truth for the split, consumed by the picker class filter, the
 * type-aware guard, and the class-tagged claude registry.
 */
import type { TaskType } from './types.js';

export type TaskClass = 'git' | 'iso';

export const ISO_TYPES: readonly TaskType[] = ['analysis', 'assistant', 'content'] as const;

export function classOf(type: TaskType): TaskClass {
  return type === 'code' || type === 'pipeline' ? 'git' : 'iso';
}

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CloneResult {
  path: string;
  cleanup(): void;
}

export function cloneToTemp(repo: string, taskId: string, token?: string): CloneResult {
  const path = `/tmp/nyx-clone-${taskId}`;
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const url = token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
  execSync(`git clone --depth 50 "${url}" "${path}"`, { stdio: 'ignore' });
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    },
  };
}

export function repoName(cloneDir: string): string {
  const remote = execSync('git remote get-url origin', { cwd: cloneDir, encoding: 'utf8' }).trim();
  const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m || !m[1]) return cloneDir;
  return m[1];
}

export function fileExists(cloneDir: string, rel: string): boolean {
  return existsSync(resolve(cloneDir, rel));
}

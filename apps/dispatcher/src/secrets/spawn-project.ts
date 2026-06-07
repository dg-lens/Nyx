import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

import { audit } from '../audit.js';
import { config } from '../config.js';
import * as notify from '../notifier.js';
import type { ParsedTask, RunOutcome } from '../types.js';

import {
  createMachineAccount,
  createProject,
  getOrgAccessToken,
  loadOrgCreds,
} from './bitwarden-client.js';
import { registerProject } from './project-registry.js';

/**
 * Built-in dispatcher handler for `BW-SPAWN-PROJECT-<NAME>` tasks.
 *
 * These tasks don't go through Claude — they're security-critical org-admin
 * operations against the Bitwarden REST API, and routing them through a
 * spawned subprocess would leak the admin credentials. The dispatcher does the
 * work itself, in-process, with audit-only logging (no Slack-leak risk for the
 * tokens themselves).
 *
 * Task ID format: `BW-SPAWN-PROJECT-<NAME>` where NAME is the project to create.
 * Optional `[repos: org/name1,org/name2]` tag on the task line associates
 * repositories with the new project so future `code` tasks against those repos
 * auto-resolve to this project's token.
 *
 * Outcome flow:
 *   1. Parse project name from task ID. Bail if malformed.
 *   2. Load org-admin creds + check org ID configured.
 *   3. OAuth → bearer.
 *   4. createProject(name) → bw_project_id.
 *   5. createMachineAccount(name-machine, bw_project_id) → {id, access_token}.
 *   6. Write access_token to ~/.config/bitwarden/<name>.token (chmod 600).
 *   7. registerProject(...) into bitwarden_projects (which audits internally).
 *   8. Audit bitwarden.project.created (id + machineAccountId, NEVER the token).
 *   9. Slack DM the operator with file location and rotation deadline.
 *
 * Any step's failure produces `task.failed` audit + Slack failure DM and the
 * task stays in Active for the 3-strike retry semantics to take over.
 */

const TASK_ID_PREFIX = 'BW-SPAWN-PROJECT-';
const REPOS_TAG_RE = /\[repos:\s*([^\]]+)\]/;

export function isSpawnProjectTask(task: ParsedTask): boolean {
  return task.id.startsWith(TASK_ID_PREFIX);
}

function projectNameFromTaskId(taskId: string): string | null {
  const suffix = taskId.slice(TASK_ID_PREFIX.length);
  if (!suffix) return null;
  // Sanitize to lower-case, replace runs of non-alphanumerics with single hyphen
  const cleaned = suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || null;
}

function reposFromTaskLines(task: ParsedTask): string[] {
  for (const line of task.rawLines) {
    const m = line.match(REPOS_TAG_RE);
    if (m && m[1]) {
      return m[1]
        .split(',')
        .map(s => s.trim())
        .filter(s => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s));
    }
  }
  return [];
}

function expandUser(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export async function handleSpawnProject(task: ParsedTask): Promise<RunOutcome> {
  const startedAt = Date.now();
  audit('task.started', 'dispatcher', { taskId: task.id, route: 'bitwarden.spawn-project' });
  await notify.taskDispatched(task.id, 'assistant', 'haiku', 'none');

  const name = projectNameFromTaskId(task.id);
  if (!name) {
    const failureLog = `task id ${task.id} does not end with a valid project name`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'parse', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }
  if (!config.bitwardenOrganizationId) {
    const failureLog =
      'BITWARDEN_ORGANIZATION_ID is not set in .env — cannot call org-admin API. ' +
      'Find the UUID in your Bitwarden web vault URL when viewing the org.';
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'config', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  let creds;
  try {
    creds = loadOrgCreds(config.bitwardenAdminCredsPath);
  } catch (err) {
    const failureLog = `loadOrgCreds failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'config', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  let bearer: string;
  try {
    bearer = await getOrgAccessToken(creds);
  } catch (err) {
    const failureLog = `Bitwarden OAuth failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'oauth', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  const orgId = config.bitwardenOrganizationId;

  // Step 1: create the project. If a project with this name already exists,
  // Bitwarden's create endpoint typically 200s with the existing row or 409s —
  // both surface here as a parseable error message. We don't auto-skip on 409
  // because the operator may have created it manually and our DB state needs
  // to catch up; failure is the safer signal.
  let projectId: string;
  try {
    const result = await createProject(bearer, orgId, name);
    projectId = result.projectId;
    audit('bitwarden.project.created', 'dispatcher', {
      taskId: task.id,
      name,
      bw_project_id: projectId,
    });
  } catch (err) {
    const failureLog = `createProject(${name}) failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'create-project', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  // Step 2: create the machine account scoped to that project and mint a token.
  let machineAccountId: string;
  let accessToken: string;
  try {
    const result = await createMachineAccount(bearer, orgId, `${name}-machine`, projectId);
    machineAccountId = result.machineAccountId;
    accessToken = result.accessToken;
  } catch (err) {
    const failureLog = `createMachineAccount(${name}-machine) failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', {
      taskId: task.id,
      failure_log: failureLog,
      bw_project_id: projectId,
    });
    await notify.taskFailed(task.id, 'create-machine-account', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  // Step 3: persist the token to disk with strict perms.
  const tokenPath = expandUser(`~/.config/bitwarden/${name}.token`);
  try {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, accessToken, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tokenPath, 0o600); // belt-and-braces in case umask interfered
  } catch (err) {
    const failureLog = `write token to ${tokenPath} failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'write-token', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  // Step 4: register in the project-registry table (audits internally).
  const repos = reposFromTaskLines(task);
  try {
    registerProject({
      name,
      bwProjectId: projectId,
      bwMachineAccountId: machineAccountId,
      tokenPath,
      repos,
      createdBy: 'dispatcher:spawn-project',
    });
  } catch (err) {
    const failureLog = `registerProject(${name}) failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', {
      taskId: task.id,
      failure_log: failureLog,
      bw_project_id: projectId,
    });
    await notify.taskFailed(task.id, 'register-project', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  // Step 5: tell the operator. NEVER include the access token itself.
  try {
    const rotateAt = new Date(Date.now() + config.bitwardenDefaultRotationDays * 86_400_000);
    const reposNote = repos.length ? ` Repos: ${repos.join(', ')}.` : '';
    await notify.dm(
      `🔑 Bitwarden project \`${name}\` ready. ` +
        `Token at \`${tokenPath}\` (chmod 600).${reposNote} ` +
        `Rotate by ${rotateAt.toISOString().slice(0, 10)}.`,
    );

    audit('task.completed', 'dispatcher', {
      taskId: task.id,
      durationMs: Date.now() - startedAt,
      bw_project_id: projectId,
      bw_machine_account_id: machineAccountId,
      token_path: tokenPath,
      repos,
    });
  } catch (err) {
    const failureLog = `spawn-project notify/audit (post-register) failed: ${(err as Error).message}`;
    audit('task.failed', 'dispatcher', {
      taskId: task.id,
      failure_log: failureLog,
      bw_project_id: projectId,
    });
    await notify.taskFailed(task.id, 'finalize', failureLog);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  return {
    taskId: task.id,
    status: 'completed',
    durationMs: Date.now() - startedAt,
  };
}

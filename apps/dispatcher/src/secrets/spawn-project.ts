import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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
import { findProjectByName, registerProject } from './project-registry.js';

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
 * Failure handling is split by where it happens, because a STANDING
 * `BW-SPAWN-PROJECT-*` task that returns `status: 'failed'` is re-picked on the
 * next tick:
 *   - BEFORE the machine account is minted (parse/config/creds/oauth through
 *     createProject): return `task.failed` — a re-pick safely retries with no
 *     orphaned state.
 *   - AFTER createMachineAccount succeeds (token write, registerProject): a
 *     re-pick would mint ANOTHER service account + live token (Bitwarden does not
 *     dedup by name). Those steps instead emit `task.halted_for_review` so
 *     `isTaskHalted` blocks re-dispatch until `nyx resume`.
 *   - The post-register notify is best-effort: completion is audited first, so a
 *     dead Slack never re-drives provisioning.
 * On re-pick, an idempotency short-circuit returns `completed` when the project
 * is already registered AND its token file is persisted with 0600 perms.
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

/** A token file counts as "persisted" only if it exists with strict 0600 perms. */
function tokenFilePersisted(tokenPath: string): boolean {
  if (!existsSync(tokenPath)) return false;
  try {
    return (statSync(tokenPath).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

/**
 * Halt the task for operator review instead of returning a re-pickable
 * `status: 'failed'`. Used for any failure AFTER a Bitwarden machine account has
 * been minted: a plain failure leaves a STANDING `BW-SPAWN-PROJECT-*` task `[ ]`
 * in Active, so the next tick re-runs `handleSpawnProject` from the top and mints
 * ANOTHER orphaned, fully-privileged service account + live token (Bitwarden does
 * not dedup by name). Emitting `task.halted_for_review` makes `isTaskHalted` skip
 * the task until `nyx resume`, so partial state is never re-driven.
 */
function haltAfterPartialProvision(
  taskId: string,
  startedAt: number,
  info: { failureLog: string; bwProjectId: string; operatorReport: string },
): RunOutcome {
  audit('task.halted_for_review', 'dispatcher', {
    taskId,
    pattern: 'bitwarden-partial-provision',
    operator_report: info.operatorReport,
    bw_project_id: info.bwProjectId,
  });
  void notify.taskHalted(taskId, 'bitwarden-partial-provision', info.operatorReport);
  return { taskId, status: 'failed', durationMs: Date.now() - startedAt, failureLog: info.failureLog };
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

  // Idempotency short-circuit: if a project of this name is already registered
  // AND its token file is persisted with 0600 perms, the prior run fully
  // provisioned it (registerProject + token write both succeeded). Re-running
  // the org-admin sequence would mint a duplicate machine account + token, so
  // treat this as a completed no-op. Catches the case where a prior tick
  // succeeded through step 4 but failed in the post-register notify/audit step.
  const existing = findProjectByName(name);
  if (existing && tokenFilePersisted(existing.token_path)) {
    audit('task.completed', 'dispatcher', {
      taskId: task.id,
      durationMs: Date.now() - startedAt,
      bw_project_id: existing.bw_project_id,
      bw_machine_account_id: existing.bw_machine_account_id,
      token_path: existing.token_path,
      already_provisioned: true,
    });
    return { taskId: task.id, status: 'completed', durationMs: Date.now() - startedAt };
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
    return haltAfterPartialProvision(task.id, startedAt, {
      failureLog,
      bwProjectId: projectId,
      operatorReport:
        `BW-SPAWN-PROJECT halted after minting a machine account but FAILING to persist its token.\n\n` +
        `${failureLog}\n\n` +
        `A live access token was created for machine account ${machineAccountId} (project ${projectId}) ` +
        `but was never written to disk — it is now unrecoverable. Revoke that machine account in the ` +
        `Bitwarden web vault, fix the write error (e.g. perms/disk on ${tokenPath}), then \`nyx resume ${task.id}\`. ` +
        `Resuming re-runs the full provision (the orphaned account must be revoked first to avoid accumulation).`,
    });
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
    return haltAfterPartialProvision(task.id, startedAt, {
      failureLog,
      bwProjectId: projectId,
      operatorReport:
        `BW-SPAWN-PROJECT halted after minting a machine account + writing its token, but FAILING to ` +
        `register the project in the registry DB.\n\n` +
        `${failureLog}\n\n` +
        `Machine account ${machineAccountId} (project ${projectId}) is live and its token is at ${tokenPath}. ` +
        `Either repair the DB and register the row by hand, or revoke the account and start over, then ` +
        `\`nyx resume ${task.id}\`. Do NOT just re-pick: the registry row is missing, so a re-run would mint a ` +
        `duplicate machine account.`,
    });
  }

  // Step 5: record completion + tell the operator. Provisioning is fully done at
  // this point (machine account minted, token persisted, registry row written),
  // so the task is complete regardless of whether the Slack DM lands. Emitting a
  // re-pickable failure here would re-drive the org-admin sequence on the next
  // tick and mint a duplicate machine account just because Slack was down — the
  // exact leak this handler must avoid. Audit the completion first; the DM is
  // best-effort. NEVER include the access token itself.
  audit('task.completed', 'dispatcher', {
    taskId: task.id,
    durationMs: Date.now() - startedAt,
    bw_project_id: projectId,
    bw_machine_account_id: machineAccountId,
    token_path: tokenPath,
    repos,
  });

  try {
    const rotateAt = new Date(Date.now() + config.bitwardenDefaultRotationDays * 86_400_000);
    const reposNote = repos.length ? ` Repos: ${repos.join(', ')}.` : '';
    await notify.dm(
      `🔑 Bitwarden project \`${name}\` ready. ` +
        `Token at \`${tokenPath}\` (chmod 600).${reposNote} ` +
        `Rotate by ${rotateAt.toISOString().slice(0, 10)}.`,
    );
  } catch {
    /* DM is best-effort — provisioning already succeeded and was audited above. */
  }

  return {
    taskId: task.id,
    status: 'completed',
    durationMs: Date.now() - startedAt,
  };
}

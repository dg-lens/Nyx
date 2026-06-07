import { audit } from '../audit.js';
import type { ParsedTask } from '../types.js';

import { openSecretsDb } from './db-schema.js';

/**
 * Maps a task to its Bitwarden machine-account token file path.
 *
 * Resolution precedence:
 *   1. Explicit `[bw-project: <name>]` tag on the task → look up by project name.
 *   2. `[repo: <org>/<name>]` tag → look up via project.repos_json containing that repo.
 *   3. No match → return null (task runs without secrets injection).
 *
 * The ParsedTask type doesn't currently surface `bw-project` — it's a free-form
 * tag the parser puts in `invalidTags` because it's not in the known list. We
 * read directly off rawLines for the tag value rather than extending the schema.
 */

const BW_PROJECT_TAG_RE = /\[bw-project:\s*([^\]]+)\]/;

export interface ProjectRow {
  id: number;
  name: string;
  bw_project_id: string;
  bw_machine_account_id: string;
  token_path: string;
  repos: string[];
  created_at: number;
  created_by: string;
}

function rowToProject(r: {
  id: number;
  name: string;
  bw_project_id: string;
  bw_machine_account_id: string;
  token_path: string;
  repos_json: string;
  created_at: number;
  created_by: string;
}): ProjectRow {
  let repos: string[] = [];
  try {
    const parsed = JSON.parse(r.repos_json);
    if (Array.isArray(parsed)) repos = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* malformed repos_json → empty list */
  }
  return {
    id: r.id,
    name: r.name,
    bw_project_id: r.bw_project_id,
    bw_machine_account_id: r.bw_machine_account_id,
    token_path: r.token_path,
    repos,
    created_at: r.created_at,
    created_by: r.created_by,
  };
}

export function findProjectByName(name: string): ProjectRow | null {
  const db = openSecretsDb();
  const row = db
    .prepare(`SELECT * FROM bitwarden_projects WHERE name = ? LIMIT 1`)
    .get(name) as Parameters<typeof rowToProject>[0] | undefined;
  return row ? rowToProject(row) : null;
}

export function findProjectByRepo(repo: string): ProjectRow | null {
  // Exact-membership test against each project's parsed repos array. LIKE on the
  // raw JSON is unsafe: SQLite treats `_`/`%` (legal in GitHub repo names) as
  // wildcards with no ESCAPE clause, so a substring/wildcard collision could
  // resolve a task to the wrong project — and thus inject another project's
  // Bitwarden token + secrets. Compare in JS to remove that class entirely.
  const db = openSecretsDb();
  const rows = db
    .prepare(`SELECT * FROM bitwarden_projects ORDER BY id ASC`)
    .all() as unknown as Array<Parameters<typeof rowToProject>[0]>;
  for (const r of rows) {
    const project = rowToProject(r);
    if (project.repos.includes(repo)) return project;
  }
  return null;
}

/**
 * Returns the token file path to use when spawning a child for this task,
 * or null if no Bitwarden injection is needed.
 */
export function resolveProjectToken(task: ParsedTask): string | null {
  const project = resolveProject(task);
  return project ? project.token_path : null;
}

/**
 * Like {@link resolveProjectToken} but returns the full project row, so callers
 * can also reach the `bw_project_id` needed to fetch secret values via the bws
 * CLI. Used by the spawn machinery to inject secrets directly as env vars
 * instead of wrapping the spawn in `bws run --` (see CHANGELOG v0.6.8).
 */
export function resolveProject(task: ParsedTask): ProjectRow | null {
  // 1. Explicit tag wins
  for (const line of task.rawLines) {
    const m = line.match(BW_PROJECT_TAG_RE);
    if (m && m[1]) {
      return findProjectByName(m[1].trim());
    }
  }
  // 2. Repo-based mapping
  if (task.repo) {
    return findProjectByRepo(task.repo);
  }
  return null;
}

export interface RegisterProjectInput {
  name: string;
  bwProjectId: string;
  bwMachineAccountId: string;
  tokenPath: string;
  repos?: string[];
  createdBy?: string;
}

/** Insert a project row. Idempotent on name conflict — updates if it exists. */
export function registerProject(input: RegisterProjectInput): ProjectRow {
  const db = openSecretsDb();
  const repos = input.repos ?? [];
  const createdBy = input.createdBy ?? 'dispatcher';
  db.prepare(
    `INSERT INTO bitwarden_projects (name, bw_project_id, bw_machine_account_id, token_path, repos_json, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       bw_project_id         = excluded.bw_project_id,
       bw_machine_account_id = excluded.bw_machine_account_id,
       token_path            = excluded.token_path,
       repos_json            = excluded.repos_json,
       created_by            = excluded.created_by`,
  ).run(
    input.name,
    input.bwProjectId,
    input.bwMachineAccountId,
    input.tokenPath,
    JSON.stringify(repos),
    Date.now(),
    createdBy,
  );
  audit('bitwarden.project.registered', createdBy, {
    name: input.name,
    bw_project_id: input.bwProjectId,
    bw_machine_account_id: input.bwMachineAccountId,
    token_path: input.tokenPath,
    repos,
  });
  return findProjectByName(input.name)!;
}

export function listProjects(): ProjectRow[] {
  const db = openSecretsDb();
  const rows = db
    .prepare(`SELECT * FROM bitwarden_projects ORDER BY name ASC`)
    .all() as unknown as Array<Parameters<typeof rowToProject>[0]>;
  return rows.map(rowToProject);
}

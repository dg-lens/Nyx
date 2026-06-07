/**
 * Heuristic failure classifier.
 *
 * The first thing the audit phase does is run the failure log through a regex
 * table. If a pattern matches, we know which class the failure belongs to and
 * (for auto-fixable classes) what the structural fix is. This is fast, cheap,
 * deterministic — no Claude API call.
 *
 * If nothing matches, the classifier returns `{ kind: 'unknown' }` and the
 * audit-runner escalates to the Claude diagnostic agent.
 *
 * Adding a new pattern: append a `PATTERNS` entry. Order matters — first match
 * wins. Patterns should be specific enough to avoid false positives, but
 * generic enough to catch every variant of the same underlying class. Add a
 * unit test in audit-classifier.test.ts when you touch this file.
 *
 * See CHANGELOG v0.7.0 for the original failure-mode catalog that seeded this.
 */

export type FailureClass =
  | 'auto-fixable'
  | 'operator-required'
  | 'unknown';

export interface ClassifiedFailure {
  kind: FailureClass;
  /** Human-readable label, e.g. 'pnpm-workspace-missing-packages' */
  pattern?: string;
  /** When kind === 'auto-fixable', the dispatcher uses this to drive the fix. */
  autofix?: AutofixHint;
  /** When kind === 'operator-required', the report shown to the operator. */
  operatorReport?: string;
}

export type AutofixHint =
  | {
      kind: 'rewrite-pnpm-workspace';
      reason: string;
    }
  | {
      kind: 'add-pnpm-build-approval';
      packages: string[];
      reason: string;
    }
  | {
      kind: 'regenerate-pnpm-lockfile';
      reason: string;
    }
  | {
      kind: 'add-devdep';
      packages: string[];
      reason: string;
    }
  | {
      kind: 'rebase-against-main';
      reason: string;
    }
  | {
      kind: 'add-mypy-plugin';
      plugin: string;
      reason: string;
    }
  | {
      kind: 'claude-rerun-with-context';
      /**
       * For "unknown but maybe fixable" failures the audit-runner can fall
       * through to here: re-run Claude with the original prompt PLUS the
       * failure log as additional context. Last-resort auto-fix.
       */
      reason: string;
    };

interface Pattern {
  /** Short identifier — shows up in audit events. */
  name: string;
  /** Regex against the failure log. */
  match: RegExp;
  /** What to do about it. */
  build: (m: RegExpMatchArray) => ClassifiedFailure;
}

// ---------- helpers ----------

function extractPackages(log: string): string[] {
  // Matches "Ignored build scripts: a@1.2.3, b@4.5.6, c@7.8.9"
  const re = /Ignored build scripts:\s*([^\n]+)/i;
  const m = log.match(re);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((s) => {
      const t = s.trim();
      const at = t.lastIndexOf('@');
      return at > 0 ? t.slice(0, at) : t;
    })
    .filter((s) => s.length > 0);
}

function extractModule(log: string): string | null {
  const m = log.match(/Cannot find module ['"]([^'"]+)['"]/);
  return m?.[1] ?? null;
}

// ---------- pattern table ----------

const PATTERNS: Pattern[] = [
  // --- auto-fixable: pnpm config drift ---
  {
    name: 'pnpm-workspace-missing-packages',
    match: /ERROR\s+packages field missing or empty/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'pnpm-workspace-missing-packages',
      autofix: {
        kind: 'rewrite-pnpm-workspace',
        reason:
          'pnpm-workspace.yaml exists but has no packages: field. Single-package repos still need packages: [\'.\'].',
      },
    }),
  },
  {
    name: 'pnpm-ignored-builds',
    match: /ERR_PNPM_IGNORED_BUILDS/i,
    build: (m) => {
      const packages = extractPackages(m.input ?? '');
      return {
        kind: 'auto-fixable',
        pattern: 'pnpm-ignored-builds',
        autofix: {
          kind: 'add-pnpm-build-approval',
          packages,
          reason: `pnpm 11 refuses to run install scripts unless explicitly approved via allowBuilds in pnpm-workspace.yaml. Packages flagged: ${packages.join(', ') || '<none parsed>'}.`,
        },
      };
    },
  },
  {
    name: 'pnpm-field-in-package-json-ignored',
    match: /The "pnpm" field in package\.json is no longer read by pnpm/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'pnpm-field-in-package-json-ignored',
      autofix: {
        kind: 'rewrite-pnpm-workspace',
        reason:
          'pnpm 11 dropped reading pnpm.* from package.json. Move onlyBuiltDependencies / allowBuilds into pnpm-workspace.yaml.',
      },
    }),
  },
  {
    name: 'pnpm-lockfile-mismatch',
    match: /ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with .* lockfile is not up to date|specifiers in the lockfile/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'pnpm-lockfile-mismatch',
      autofix: {
        kind: 'regenerate-pnpm-lockfile',
        reason: 'pnpm-lock.yaml is out of sync with package.json. Regenerate.',
      },
    }),
  },

  // --- auto-fixable: missing devDep / runtime dep ---
  {
    name: 'missing-eslint-plugin',
    match: /Failed to load plugin ['"]react-hooks['"]/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'missing-eslint-plugin',
      autofix: {
        kind: 'add-devdep',
        packages: ['eslint-plugin-react-hooks'],
        reason:
          'eslint-config-next references eslint-plugin-react-hooks but pnpm strict transitive deps left it out.',
      },
    }),
  },
  {
    name: 'cannot-find-module',
    match: /Cannot find module ['"]([^'"]+)['"]/,
    build: (m) => {
      const mod = extractModule(m.input ?? '');
      // Be conservative: only auto-add devDeps for KNOWN-safe names.
      // Anything else escalates so we don't mass-install random packages.
      const KNOWN_SAFE = new Set([
        'eslint-plugin-react-hooks',
        'eslint-plugin-react',
        '@types/node',
        '@types/react',
        '@types/react-dom',
      ]);
      if (mod && KNOWN_SAFE.has(mod)) {
        return {
          kind: 'auto-fixable',
          pattern: 'cannot-find-module',
          autofix: {
            kind: 'add-devdep',
            packages: [mod],
            reason: `Code references ${mod} which isn't in devDependencies.`,
          },
        };
      }
      return {
        kind: 'unknown',
        pattern: 'cannot-find-module',
      };
    },
  },

  // --- auto-fixable: mypy plugin missing (Python repos) ---
  {
    name: 'mypy-untyped-decorator-sqlalchemy',
    match: /Untyped decorator makes function [\s\S]*? untyped[\s\S]*?sqlalchemy/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'mypy-untyped-decorator-sqlalchemy',
      autofix: {
        kind: 'add-mypy-plugin',
        plugin: 'sqlalchemy.ext.mypy.plugin',
        reason: 'SQLAlchemy 2.x types need the sqlalchemy mypy plugin to resolve.',
      },
    }),
  },
  {
    name: 'mypy-pydantic-basemodel-any',
    match: /Class cannot subclass ['"]BaseModel['"]\s*\(has type ['"]Any['"]\)/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'mypy-pydantic-basemodel-any',
      autofix: {
        kind: 'add-mypy-plugin',
        plugin: 'pydantic.mypy',
        reason:
          'Pydantic v2 needs the pydantic.mypy plugin so BaseModel subclasses type-check.',
      },
    }),
  },

  // --- auto-fixable: branch behind main ---
  {
    name: 'git-merge-conflict',
    match: /CONFLICT \(content\)|Automatic merge failed; fix conflicts/i,
    build: () => ({
      kind: 'auto-fixable',
      pattern: 'git-merge-conflict',
      autofix: {
        kind: 'rebase-against-main',
        reason: 'Branch diverged from main. Rebasing in working dir.',
      },
    }),
  },

  // --- operator-required: external system / config ---
  {
    name: 'repo-not-found',
    match: /Repository not found|remote: Repository not found/i,
    build: (m) => ({
      kind: 'operator-required',
      pattern: 'repo-not-found',
      operatorReport: `The repo this task targets doesn't exist or the token can't see it. Check the [repo:] tag spelling and the GitHub token's permissions. Failure log excerpt:\n\n${m.input?.slice(0, 600)}`,
    }),
  },
  {
    name: 'bws-secret-missing',
    match: /(SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET|OPERATOR_AUTH_TOKEN)\s+is not defined|missing required env var[:\s]+([A-Z0-9_]+)/i,
    build: (m) => {
      const varName = m[1] ?? m[2] ?? '<unknown>';
      return {
        kind: 'operator-required',
        pattern: 'bws-secret-missing',
        operatorReport: `Task needs env var \`${varName}\` but it's not in the Bitwarden project (or not yet propagated). Add it via:\n\n  BWS_ACCESS_TOKEN=$(cat ~/.config/bitwarden/<project>.token) \\\n    bws secret create ${varName} '<value>' <project-uuid>\n\nThen run \`nyx-resume <TASK-ID>\`.`,
      };
    },
  },
  {
    name: 'supabase-table-missing',
    match: /relation ['"]([^'"]+)['"]\s+does not exist/i,
    build: (m) => {
      const table = m[1] ?? '<unknown>';
      return {
        kind: 'operator-required',
        pattern: 'supabase-table-missing',
        operatorReport: `Database table \`${table}\` doesn't exist in the target Supabase project. A prior migration task likely didn't actually apply. Run the migration manually via the Supabase SQL editor, then \`nyx-resume <TASK-ID>\`.`,
      };
    },
  },
  {
    name: 'network-refused',
    match: /ECONNREFUSED|ENOTFOUND|getaddrinfo/i,
    build: () => ({
      kind: 'operator-required',
      pattern: 'network-refused',
      operatorReport:
        'Task tried to reach an external service and got a network error. Check that the service is up and reachable from this machine. Then `nyx-resume <TASK-ID>`.',
    }),
  },
  {
    name: 'safety-filter',
    match: /prompt was rejected|safety filter|content policy/i,
    build: () => ({
      kind: 'operator-required',
      pattern: 'safety-filter',
      operatorReport:
        "Claude rejected the prompt as a safety violation. Rephrase the task description and `nyx-resume <TASK-ID>`.",
    }),
  },
  {
    name: 'claude-input-malformed',
    match: /Input must be provided either through stdin or as a prompt argument when using --print/i,
    build: () => ({
      kind: 'operator-required',
      pattern: 'claude-input-malformed',
      operatorReport:
        'Claude CLI received --print with no prompt. This typically means the spawn invocation got mangled by a shell. Check git-ops + task-runner; should not happen on v0.6.8+.',
    }),
  },
];

export function classifyFailure(failureLog: string): ClassifiedFailure {
  for (const p of PATTERNS) {
    const m = failureLog.match(p.match);
    if (m) return p.build(m);
  }
  return { kind: 'unknown' };
}

/** Test/introspection helper: list every pattern name and its kind. */
export function listPatterns(): { name: string; kind: FailureClass }[] {
  return PATTERNS.map((p) => {
    const sample = p.build({ input: '', 0: '' } as unknown as RegExpMatchArray);
    return { name: p.name, kind: sample.kind };
  });
}

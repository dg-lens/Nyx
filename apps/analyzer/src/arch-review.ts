import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { addFinding, type FindingsReport, newReport } from './findings.js';

function trackedFiles(cwd: string): string[] {
  try {
    return execSync('git ls-files', { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { return []; }
}

function readPkg(cwd: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null {
  const p = resolve(cwd, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function findUnusedDeps(cwd: string, report: FindingsReport): void {
  const pkg = readPkg(cwd);
  if (!pkg) return;
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) return;

  const files = trackedFiles(cwd).filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !/(^|\/)node_modules\//.test(f));
  const corpus = files.map(f => {
    try { return readFileSync(resolve(cwd, f), 'utf8'); } catch { return ''; }
  }).join('\n');

  const unused = deps.filter(d => {
    const importRe = new RegExp(`(?:from\\s+['"\`]${d}(?:/|['"\`])|require\\(['"\`]${d}(?:/|['"\`])|import\\s+['"\`]${d}(?:/|['"\`]))`);
    return !importRe.test(corpus);
  });

  for (const dep of unused) {
    addFinding(report, {
      id: `unused-dep-${dep}`,
      severity: 'low',
      category: 'dependency',
      title: `Dependency \`${dep}\` appears unused`,
      recommendation: `If truly unused, remove with the relevant package manager. False positives happen with type-only or peer deps — verify before removing.`,
    });
  }
}

function findLargeFiles(cwd: string, report: FindingsReport): void {
  const files = trackedFiles(cwd);
  for (const rel of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(rel)) continue;
    if (/(^|\/)node_modules\//.test(rel)) continue;
    const abs = resolve(cwd, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, 'utf8').split('\n').length;
    if (lines > 600) {
      addFinding(report, {
        id: `large-file-${rel}`,
        severity: 'low',
        category: 'maintainability',
        title: `Large file (${lines} lines): ${rel}`,
        file: rel,
        recommendation: 'Consider splitting. Files over 600 lines tend to bundle unrelated responsibilities and resist test coverage.',
      });
    }
  }
}

function detectCircularImports(cwd: string, report: FindingsReport): void {
  const res = spawnSync('npx', ['--yes', 'madge', '--circular', '--extensions', 'ts,tsx,js,jsx', '.'], {
    cwd, encoding: 'utf8', timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  if (/Found \d+ circular/i.test(out)) {
    addFinding(report, {
      id: 'circular-imports',
      severity: 'medium',
      category: 'architecture',
      title: 'Circular imports detected',
      evidence: out.slice(0, 1500),
      recommendation: 'Break cycles by extracting shared types/utilities into a separate leaf module. Cycles cause subtle initialization-order bugs and confuse bundlers.',
    });
  }
}

function findTestCoverageGaps(cwd: string, report: FindingsReport): void {
  const files = trackedFiles(cwd).filter(f => /\.(ts|tsx|js|jsx)$/.test(f) && !/(^|\/)node_modules\//.test(f));
  const tests = new Set(files.filter(f => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f)).map(f => f.replace(/\.(test|spec)\./, '.')));
  const sources = files.filter(f => !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
  const untested = sources.filter(f => {
    const abs = resolve(cwd, f);
    if (!existsSync(abs)) return false;
    if (statSync(abs).size < 200) return false;
    return !tests.has(f);
  });
  if (untested.length > 0) {
    addFinding(report, {
      id: 'test-coverage-low',
      severity: 'info',
      category: 'testing',
      title: `${untested.length} source files have no co-located test`,
      recommendation: 'This is a heuristic, not a coverage report. Use it as a starting point for coverage prioritization.',
    });
  }
}

export function runArchReview(cwd: string, repo: string): FindingsReport {
  const report = newReport(repo, 'arch-review');
  findUnusedDeps(cwd, report);
  findLargeFiles(cwd, report);
  detectCircularImports(cwd, report);
  findTestCoverageGaps(cwd, report);
  return report;
}

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { addFinding, type Finding, type FindingsReport, newReport } from './findings.js';

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic API key', pattern: /(?:api[_-]?key|secret)[\s:='"`]+[A-Za-z0-9_\-]{20,}/gi },
  { name: 'Slack bot token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'GitHub personal token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'Private key block', pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'JWT-shaped string', pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
];

function trackedFiles(cwd: string): string[] {
  try {
    const out = execSync('git ls-files', { cwd, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isLikelyBinary(rel: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp[34]|mov|wav)$/i.test(rel);
}

function scanSecrets(cwd: string, report: FindingsReport): void {
  for (const rel of trackedFiles(cwd)) {
    if (isLikelyBinary(rel)) continue;
    if (rel.startsWith('.git/')) continue;
    if (/(^|\/)node_modules\//.test(rel)) continue;
    const abs = resolve(cwd, rel);
    if (!existsSync(abs)) continue;
    let body: string;
    try { body = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = body.split('\n');
    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = body.match(pattern);
      if (!matches) continue;
      const first = matches[0];
      const lineIdx = lines.findIndex(l => l.includes(first));
      const finding: Finding = {
        id: `secret-${name.replace(/\s+/g, '-').toLowerCase()}-${rel}`,
        severity: 'critical',
        category: 'secret',
        title: `Possible ${name} committed`,
        file: rel,
        ...(lineIdx >= 0 ? { line: lineIdx + 1 } : {}),
        evidence: first.slice(0, 120),
        recommendation: `Rotate the credential immediately, remove from history with git filter-repo, and add the pattern to .gitignore.`,
      };
      addFinding(report, finding);
    }
  }
}

function scanEnvFiles(cwd: string, report: FindingsReport): void {
  const candidates = ['.env', '.env.local', '.env.production'];
  for (const c of candidates) {
    const abs = resolve(cwd, c);
    if (!existsSync(abs)) continue;
    try {
      execSync(`git ls-files --error-unmatch "${c}"`, { cwd, stdio: 'ignore' });
      addFinding(report, {
        id: `env-committed-${c}`,
        severity: 'critical',
        category: 'secret-hygiene',
        title: `${c} is tracked by git`,
        file: c,
        recommendation: `Add ${c} to .gitignore and rotate any credentials it contained.`,
      });
    } catch {
      // not tracked — fine
    }
  }
}

function normalizeSeverity(raw: string | undefined): Finding['severity'] {
  const sev = (raw ?? 'medium').toLowerCase();
  return (['critical', 'high', 'medium', 'low', 'info'].includes(sev) ? sev : 'medium') as Finding['severity'];
}

function runDependencyAudit(cwd: string, report: FindingsReport): void {
  if (!existsSync(resolve(cwd, 'package.json'))) return;
  const tools: Array<{ cmd: string; args: string[]; shape: 'advisories' | 'vulnerabilities' }> = [];
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) tools.push({ cmd: 'pnpm', args: ['audit', '--json'], shape: 'advisories' });
  else if (existsSync(resolve(cwd, 'yarn.lock'))) tools.push({ cmd: 'yarn', args: ['npm', 'audit', '--json'], shape: 'advisories' });
  else tools.push({ cmd: 'npm', args: ['audit', '--json'], shape: 'vulnerabilities' });

  for (const tool of tools) {
    const res = spawnSync(tool.cmd, tool.args, { cwd, encoding: 'utf8', timeout: 180_000 });
    const blob = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (!blob.trim()) continue;
    try {
      const parsed = JSON.parse(res.stdout ?? '{}') as {
        vulnerabilities?: Record<string, { severity?: string; via?: unknown[]; range?: string }>;
        advisories?: Record<string, { severity?: string; module_name?: string; title?: string; url?: string }>;
      };
      if (tool.shape === 'advisories') {
        const advisories = parsed.advisories ?? {};
        for (const [key, a] of Object.entries(advisories)) {
          const pkg = a.module_name ?? key;
          const sev = (a.severity ?? 'medium').toLowerCase();
          addFinding(report, {
            id: `dep-${pkg}`,
            severity: normalizeSeverity(sev),
            category: 'dependency',
            title: `${pkg} has a ${sev} advisory${a.title ? `: ${a.title}` : ''}`,
            ...(a.url ? { evidence: a.url } : {}),
            recommendation: `Run \`${tool.cmd} update ${pkg}\` or pin to a patched version.`,
          });
        }
      } else {
        const vulns = parsed.vulnerabilities ?? {};
        for (const [pkg, v] of Object.entries(vulns)) {
          const sev = (v.severity ?? 'medium').toLowerCase();
          addFinding(report, {
            id: `dep-${pkg}`,
            severity: normalizeSeverity(sev),
            category: 'dependency',
            title: `${pkg} has a ${sev} advisory`,
            recommendation: `Run \`${tool.cmd} update ${pkg}\` or pin to a patched version.`,
          });
        }
      }
    } catch {
      // npm <8 prints non-JSON; ignore
    }
    return;
  }
}

function scanCSPHeaders(cwd: string, report: FindingsReport): void {
  const candidates = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'middleware.ts', 'src/middleware.ts'];
  let foundCSP = false;
  for (const c of candidates) {
    const abs = resolve(cwd, c);
    if (!existsSync(abs)) continue;
    try {
      const body = readFileSync(abs, 'utf8');
      if (/Content-Security-Policy/i.test(body)) { foundCSP = true; break; }
    } catch { /* noop */ }
  }
  if (!foundCSP && (existsSync(resolve(cwd, 'next.config.js')) || existsSync(resolve(cwd, 'next.config.mjs')) || existsSync(resolve(cwd, 'next.config.ts')))) {
    addFinding(report, {
      id: 'csp-missing',
      severity: 'medium',
      category: 'headers',
      title: 'No Content-Security-Policy header configured',
      recommendation: 'Add a CSP via next.config headers() or middleware. Start with `default-src self` and tighten.',
    });
  }
}

function scanCORS(cwd: string, report: FindingsReport): void {
  for (const rel of trackedFiles(cwd)) {
    if (!/\.(ts|tsx|js|jsx)$/.test(rel)) continue;
    if (/(^|\/)node_modules\//.test(rel)) continue;
    const abs = resolve(cwd, rel);
    let body: string;
    try { body = readFileSync(abs, 'utf8'); } catch { continue; }
    if (/Access-Control-Allow-Origin.{0,40}\*/.test(body)) {
      addFinding(report, {
        id: `cors-wildcard-${rel}`,
        severity: 'high',
        category: 'cors',
        title: `Wildcard CORS origin in ${rel}`,
        file: rel,
        recommendation: 'Restrict to specific origins. Wildcard is unsafe for any endpoint that uses credentials or returns sensitive data.',
      });
    }
  }
}

export function runSecurityScan(cwd: string, repo: string): FindingsReport {
  const report = newReport(repo, 'security-scan');
  scanEnvFiles(cwd, report);
  scanSecrets(cwd, report);
  runDependencyAudit(cwd, report);
  scanCSPHeaders(cwd, report);
  scanCORS(cwd, report);
  return report;
}

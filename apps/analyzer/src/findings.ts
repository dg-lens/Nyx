export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  file?: string;
  line?: number;
  evidence?: string;
  recommendation: string;
}

export interface FindingsReport {
  generatedAt: string;
  repo: string;
  scanType: string;
  findings: Finding[];
  summary: Record<Severity, number>;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

export function newReport(repo: string, scanType: string): FindingsReport {
  return {
    generatedAt: new Date().toISOString(),
    repo,
    scanType,
    findings: [],
    summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
}

export function addFinding(report: FindingsReport, f: Finding): void {
  report.findings.push(f);
  report.summary[f.severity]++;
}

export function sortFindings(report: FindingsReport): void {
  report.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function toMarkdown(report: FindingsReport): string {
  sortFindings(report);
  const lines: string[] = [];
  lines.push(`# ${report.scanType} — ${report.repo}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as Severity[]) {
    lines.push(`- ${sev}: ${report.summary[sev]}`);
  }
  lines.push('');
  lines.push('## Findings');
  if (report.findings.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }
  for (const f of report.findings) {
    lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(`Category: ${f.category}`);
    if (f.file) lines.push(`File: \`${f.file}${f.line ? `:${f.line}` : ''}\``);
    if (f.evidence) {
      lines.push('');
      lines.push('Evidence:');
      lines.push('```');
      lines.push(f.evidence);
      lines.push('```');
    }
    lines.push('');
    lines.push(`Recommendation: ${f.recommendation}`);
    lines.push('');
  }
  return lines.join('\n');
}

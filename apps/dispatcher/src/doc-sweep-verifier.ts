/**
 * Doc-sweep verifier — checks that declared `## Doc updates` paths were
 * actually touched by the agent before finalize commits the work.
 *
 * Contract enforced here:
 *   - If the task spec contains a `## Doc updates` section with concrete path
 *     references, each referenced file must appear in the agent's diff.
 *   - T1 references (`~/.claude/CLAUDE.md`) are outside any working dir's git
 *     scope and are skipped (unverifiable).
 *   - Advisory T4 lines ("write a T4 entry per the protocol") are skipped.
 *   - A task with NO `## Doc updates` section passes unconditionally — the
 *     decomposer's judgment that none are needed is respected.
 *   - Fuzzy references without a concrete path ("T3 of the affected repo") are
 *     caught at preflight (checkDocUpdatesSpecMalformed), not at finalize.
 */

const DOC_UPDATES_HEADING_RE = /^\s*##\s+Doc updates\s*$/im;

export type DocSweepResult =
  | { ok: true; verifiedPaths: string[] }
  | { ok: false; missing: string[]; verifiedPaths: string[] };

/**
 * Verify that every concrete file path declared in the `## Doc updates`
 * section of `taskSpecBody` appears in `diffFiles`.
 *
 * @param taskSpecBody  Full raw text of the task spec (task.rawLines.join('\n')).
 * @param diffFiles     Files touched by the agent (from changedFilesWorkingTree).
 */
export function verifyDocUpdates(
  taskSpecBody: string,
  diffFiles: string[],
): DocSweepResult {
  const bullets = extractDocUpdateBullets(taskSpecBody);
  if (bullets === null) return { ok: true, verifiedPaths: [] };

  const paths = extractVerifiablePaths(bullets);
  if (paths.length === 0) return { ok: true, verifiedPaths: [] };

  const missing: string[] = [];
  const verified: string[] = [];
  for (const p of paths) {
    if (isPathInDiff(p, diffFiles)) {
      verified.push(p);
    } else {
      missing.push(p);
    }
  }

  if (missing.length > 0) return { ok: false, missing, verifiedPaths: verified };
  return { ok: true, verifiedPaths: verified };
}

/**
 * Return a human-readable error string if the `## Doc updates` section
 * contains a fuzzy tier reference without a concrete file path (malformed
 * spec), or null if the spec is well-formed.
 *
 * Called at preflight time for code tasks so malformed specs fail before
 * any Claude compute is spent.
 */
export function checkDocUpdatesSpecMalformed(taskSpecBody: string): string | null {
  const bullets = extractDocUpdateBullets(taskSpecBody);
  if (bullets === null) return null;

  for (const bullet of bullets) {
    if (isFuzzyTierReference(bullet)) {
      const excerpt = bullet.replace(/^[-\s]+/, '').slice(0, 120).trim();
      return (
        `## Doc updates contains a fuzzy tier reference without a concrete file path: "${excerpt}". ` +
        `Replace with an explicit path like "T3 apps/foo/CLAUDE.md: ..." and re-queue.`
      );
    }
  }
  return null;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function extractDocUpdateBullets(body: string): string[] | null {
  const headingMatch = DOC_UPDATES_HEADING_RE.exec(body);
  if (!headingMatch) return null;

  const startIdx = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(startIdx);

  // Stop at the next ## heading or at tag lines like [type:, [model:, [gate:.
  const stopMatch = /^\s*(?:##|\[[a-z])/m.exec(rest);
  const section = stopMatch ? rest.slice(0, stopMatch.index) : rest;

  return section.split('\n').filter((line) => line.trim().startsWith('-'));
}

function isFuzzyTierReference(bullet: string): boolean {
  const content = bullet.replace(/^[-\s]+/, '').trim();
  // "T2 of the affected repo", "T3 in the relevant sub-app", etc.
  if (/^T[234]\s+(of\s+the|in\s+the|for\s+the|from\s+the)/i.test(content)) return true;
  // Bare "T3:" or "T3 —" with no path
  if (/^T[234](?:\s*:|:\s*$|\s*—|\s*$)/.test(content)) return true;
  return false;
}

function extractVerifiablePaths(bullets: string[]): string[] {
  const paths: string[] = [];

  for (const bullet of bullets) {
    const content = bullet.replace(/^[-\s]+/, '').trim();

    // T1 — ~/.claude/CLAUDE.md, outside any working dir's git scope
    if (/^T1(\s|§|$)/i.test(content)) continue;

    // Advisory T4 lines — "write a T4 entry per the protocol", etc.
    if (/write\s+a?\s*T4\s+entry/i.test(content)) continue;
    if (/^T4\s+(entry|per\s+the|if\s+)/i.test(content)) continue;

    // T2/T3 with path in parens: T2 (~/Nyx/CLAUDE.md) or T3 (apps/foo/CLAUDE.md)
    const tierParenMatch = /^T[23]\s*\(([^)]+)\)/i.exec(content);
    if (tierParenMatch?.[1]) {
      const p = cleanPath(tierParenMatch[1]);
      if (p) { paths.push(normalizePath(p)); continue; }
    }

    // T2/T3 with path directly (no parens): T3 apps/foo/CLAUDE.md or T2 ~/Nyx/CLAUDE.md
    const tierPathMatch = /^T[23]\s+([\w~/][^\s:—\n]*\.md)/i.exec(content);
    if (tierPathMatch?.[1]) {
      const p = cleanPath(tierPathMatch[1]);
      if (p) { paths.push(normalizePath(p)); continue; }
    }

    // Ad-hoc paths in parens: (apps/foo/CLAUDE.md) or (apps/foo/CLAUDE.md — description)
    const parenPathMatch = /\(([^)]+\.md[^)]*)\)/i.exec(content);
    if (parenPathMatch?.[1]) {
      const p = cleanPath(parenPathMatch[1]);
      if (p && (p.includes('/') || p === 'CLAUDE.md') && !paths.includes(normalizePath(p))) {
        paths.push(normalizePath(p));
        continue;
      }
    }

    // Backtick-quoted paths with at least one slash and ending in .md: `apps/foo/CLAUDE.md`
    for (const m of content.matchAll(/`([^`]*\/[^`]*\.md)`/g)) {
      if (m[1]) {
        const p = normalizePath(m[1]);
        if (!paths.includes(p)) paths.push(p);
      }
    }
  }

  return [...new Set(paths)];
}

function cleanPath(raw: string): string | null {
  let s = raw.trim().replace(/`/g, '');
  // Strip after em-dash / en-dash: "path — description"
  s = s.replace(/\s*[—–]\s.*$/, '');
  // Strip colon-space-description: "path: what to change"
  s = s.replace(/\s*:\s+\S.*$/, '');
  s = s.trim();
  if (!s) return null;
  // Must look like a file path (has a slash, or is CLAUDE.md, or ends in .md)
  if (!s.includes('/') && s !== 'CLAUDE.md' && !s.endsWith('.md')) return null;
  return s;
}

function normalizePath(p: string): string {
  // ~/Nyx/ prefix → relative to Nyx repo root for working-tree comparison
  if (p.startsWith('~/Nyx/')) return p.slice('~/Nyx/'.length);
  return p;
}

function isPathInDiff(declaredPath: string, diffFiles: string[]): boolean {
  // ~/.claude/ paths live outside any working dir; can't verify via git — skip
  if (declaredPath.startsWith('~/.claude/')) return true;
  // Other absolute / unresolvable home paths
  if (declaredPath.startsWith('/') || declaredPath.startsWith('~/')) return true;

  // Exact match
  if (diffFiles.includes(declaredPath)) return true;

  // Suffix match handles cases where diffFiles entries have a longer prefix
  return diffFiles.some((f) => f.endsWith('/' + declaredPath));
}

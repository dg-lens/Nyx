import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildIndex, memoryDir, type NodeMeta } from '@nyx/dispatcher/dist/memory/arachne.js';

function expandUser(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/**
 * Resolve the Nyx data directory the same way the dispatcher's config does, but
 * without importing it (that module loads dotenv + opens the audit DB as a side
 * effect). Honors NYX_DATA_DIR, else falls back to a sibling `Data/` of the repo
 * root, else the repo root.
 */
export function resolveDataDir(): string {
  const env = process.env['NYX_DATA_DIR'];
  if (env) return expandUser(env);
  const repoRoot = process.env['NYX_REPO_ROOT']
    ? expandUser(process.env['NYX_REPO_ROOT'])
    : resolve(import.meta.dirname, '..', '..', '..');
  const sibling = resolve(repoRoot, '..', 'Data');
  return existsSync(sibling) ? sibling : repoRoot;
}

/** The vault's `memory/` directory for the resolved (or supplied) data dir. */
export function vaultDir(dataDir = resolveDataDir()): string {
  return memoryDir(dataDir);
}

/**
 * In-process index cache. The hot read paths reuse one compiled index; a write or
 * an explicit reload invalidates it so the next read rebuilds. `buildIndex`
 * swallows parse failures, so the cache faithfully mirrors what retrieval sees.
 */
export class IndexCache {
  private cached: NodeMeta[] | null = null;
  constructor(private readonly dir: string) {}

  get(): NodeMeta[] {
    if (this.cached === null) this.cached = buildIndex(this.dir);
    return this.cached;
  }

  reload(): number {
    this.cached = buildIndex(this.dir);
    return this.cached.length;
  }

  invalidate(): void {
    this.cached = null;
  }

  get vault(): string {
    return this.dir;
  }
}

export interface ValidationResult {
  ok: boolean;
  indexCount: number;
  fileCount: number;
  parseFailures: Array<{ file: string; error: string }>;
}

/**
 * Corruption detector. `buildIndex` silently drops any file whose frontmatter
 * fails to parse (its `catch {}`), so a node can vanish from retrieval with no
 * error surfaced. This re-walks the vault applying the SAME parse the engine uses
 * and reports every file that throws or yields no node, plus the index-count vs
 * file-count delta.
 */
export function validateVault(dir: string): ValidationResult {
  const parseFailures: Array<{ file: string; error: string }> = [];
  let fileCount = 0;
  for (const sub of ['nodes', 'moc']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.md')) continue;
      fileCount++;
      const full = join(d, f);
      try {
        const text = readFileSync(full, 'utf8');
        if (!text.startsWith('---')) {
          parseFailures.push({ file: f, error: 'missing leading frontmatter delimiter' });
          continue;
        }
        const end = text.indexOf('\n---', 3);
        if (end === -1) {
          parseFailures.push({ file: f, error: 'unterminated frontmatter block' });
          continue;
        }
        const fm = parseYaml(text.slice(3, end)) as Record<string, unknown> | null;
        if (!fm || fm['id'] == null) {
          parseFailures.push({ file: f, error: 'frontmatter parsed but missing required `id`' });
        }
      } catch (e) {
        parseFailures.push({ file: f, error: (e as Error).message });
      }
    }
  }
  const indexCount = buildIndex(dir).length;
  return {
    ok: parseFailures.length === 0 && indexCount === fileCount,
    indexCount,
    fileCount,
    parseFailures,
  };
}

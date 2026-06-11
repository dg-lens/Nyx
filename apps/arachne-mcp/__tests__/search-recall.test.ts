import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IndexCache } from '../src/vault.js';
import { searchTool } from '../src/tools.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Fixture copies of two REAL vault nodes that memory_search failed to recall when
// the engine required the whole query phrase as one contiguous substring. Keep
// them verbatim — the point is recall against the corpus shape as authored.
function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'arachne-recall-'));
  const dir = join(root, 'memory');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  for (const f of ['greenfield-target-mode.md', 'assistant-task-hang-mcp-heavy.md']) {
    copyFileSync(join(FIXTURES, f), join(dir, 'nodes', f));
  }
  return dir;
}

describe('memory_search recall regressions', () => {
  test('"pipeline target" surfaces greenfield-target-mode', () => {
    const cache = new IndexCache(vault());
    const hits = searchTool(cache, { query: 'pipeline target' });
    assert.ok(
      hits.map((h) => h.id).includes('greenfield-target-mode'),
      'query terms spanning trigger ("target mode") + other fields must still recall the node',
    );
  });

  test('"assistant task hang exit 124" surfaces assistant-task-hang-mcp-heavy', () => {
    const cache = new IndexCache(vault());
    const hits = searchTool(cache, { query: 'assistant task hang exit 124' });
    assert.ok(
      hits.map((h) => h.id).includes('assistant-task-hang-mcp-heavy'),
      'no contiguous phrase exists — tokenized any-overlap must recall via triggers/id',
    );
  });
});

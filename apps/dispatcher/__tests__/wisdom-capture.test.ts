import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  WISDOM_FILE,
  buildWisdomPrompt,
  parseWisdomFile,
  routeWisdomCapture,
  _setDiagMemoryDir,
  _setDeveloperPersonalityPath,
  _setMemoryNodesDir,
  type WisdomCapture,
} from '../src/wisdom-capture.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-wisdom-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  _setDiagMemoryDir(null);
  _setDeveloperPersonalityPath(null);
  _setMemoryNodesDir(null);
});

describe('routeWisdomCapture — Graph target (memory vault)', () => {
  test('Graph create writes a parseable node with quoted summary', () => {
    const nodesDir = resolve(tmpDir, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    _setMemoryNodesDir(nodesDir);
    writeWisdom(
      { target: 'Graph', id: 'demo-graph-lesson', kind: 'lesson', scope: ['nyx'], summary: 'x: y has a colon' },
      'The lesson body.',
    );
    const wisdom = parseWisdomFile(tmpDir) as WisdomCapture;
    assert.equal(wisdom.target, 'Graph');
    const { fileModified } = routeWisdomCapture(wisdom, 'TASK-1', tmpDir);
    assert.ok(fileModified && fileModified.endsWith('demo-graph-lesson.md'));
    const raw = readFileSync(fileModified!, 'utf8');
    assert.match(raw, /summary: "x: y has a colon"/);
    assert.match(raw, /kind: lesson/);
    assert.match(raw, /The lesson body\./);
  });

  test('Graph on an existing id appends, does not clobber', () => {
    const nodesDir = resolve(tmpDir, 'nodes');
    mkdirSync(nodesDir, { recursive: true });
    _setMemoryNodesDir(nodesDir);
    writeFileSync(resolve(nodesDir, 'existing.md'), '---\nid: existing\n---\n\noriginal body\n');
    writeWisdom({ target: 'Graph', id: 'existing', kind: 'lesson', scope: ['nyx'], summary: 's' }, 'appended insight.');
    const wisdom = parseWisdomFile(tmpDir) as WisdomCapture;
    routeWisdomCapture(wisdom, 'TASK-2', tmpDir);
    const raw = readFileSync(resolve(nodesDir, 'existing.md'), 'utf8');
    assert.match(raw, /original body/);
    assert.match(raw, /appended insight/);
  });

  test('Graph without a valid id is rejected (parse returns null)', () => {
    writeWisdom({ target: 'Graph', kind: 'lesson', scope: ['nyx'], summary: 's' }, 'no id.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });
});

function writeWisdom(meta: object, paragraph: string): void {
  const content = `\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${paragraph}`;
  writeFileSync(resolve(tmpDir, WISDOM_FILE), content);
}

// ─── parseWisdomFile — absent / malformed ──────────────────────────────────────

describe('parseWisdomFile — file absent', () => {
  test('returns null when NYX_WISDOM.md does not exist', () => {
    assert.equal(parseWisdomFile(tmpDir), null);
  });
});

describe('parseWisdomFile — malformed files', () => {
  test('returns null for file with no json fence', () => {
    writeFileSync(resolve(tmpDir, WISDOM_FILE), 'Just some text, no fence.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null for file with invalid JSON in fence', () => {
    writeFileSync(resolve(tmpDir, WISDOM_FILE), '```json\nnot json {{{\n```\n\nParagraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when target is missing from meta', () => {
    writeWisdom({ slug: 'my-slug' }, 'Paragraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when target is invalid', () => {
    writeWisdom({ target: 'Invalid' }, 'Paragraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when paragraph is empty after fence', () => {
    const content = '```json\n{"target":"None"}\n```\n\n   ';
    writeFileSync(resolve(tmpDir, WISDOM_FILE), content);
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when slug is present but not a string', () => {
    writeWisdom({ target: 'T4', slug: 42 }, 'Paragraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when path is present but not a string', () => {
    writeWisdom({ target: 'T2', path: true }, 'Paragraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });

  test('returns null when agent_reason is present but not a string', () => {
    writeWisdom({ target: 'None', agent_reason: 123 }, 'Paragraph.');
    assert.equal(parseWisdomFile(tmpDir), null);
  });
});

describe('parseWisdomFile — valid schemas', () => {
  test('parses minimal valid schema (target None, no optionals)', () => {
    writeWisdom({ target: 'None' }, 'Nothing learned here.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.target, 'None');
    assert.equal(result.paragraph, 'Nothing learned here.');
    assert.equal(result.slug, undefined);
    assert.equal(result.path, undefined);
    assert.equal(result.agentReason, undefined);
  });

  test('parses T4 target with slug', () => {
    writeWisdom(
      { target: 'T4', slug: 'my-lesson', agent_reason: 'Bug was hard to debug' },
      'The root cause was X.',
    );
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.target, 'T4');
    assert.equal(result.slug, 'my-lesson');
    assert.equal(result.agentReason, 'Bug was hard to debug');
    assert.equal(result.paragraph, 'The root cause was X.');
  });

  test('parses T2 target with path', () => {
    writeWisdom({ target: 'T2', path: 'CLAUDE.md', section: 'Env vars' }, 'A new env var was added.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.target, 'T2');
    assert.equal(result.path, 'CLAUDE.md');
    assert.equal(result.section, 'Env vars');
  });

  test('parses T3 target with relative path', () => {
    writeWisdom({ target: 'T3', path: 'apps/foo/CLAUDE.md' }, 'Sub-app lesson.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.target, 'T3');
    assert.equal(result.path, 'apps/foo/CLAUDE.md');
  });

  test('parses Personality target', () => {
    writeWisdom({ target: 'Personality', agent_reason: 'Naming pattern clarified' }, 'Use snake_case for DB columns.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.target, 'Personality');
  });

  test('null slug/path/section fields are treated as absent', () => {
    writeWisdom({ target: 'None', slug: null, path: null, section: null }, 'Paragraph.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.slug, undefined);
    assert.equal(result.path, undefined);
    assert.equal(result.section, undefined);
  });

  test('multi-line paragraph is preserved', () => {
    writeWisdom({ target: 'None' }, 'Line one.\nLine two.\nLine three.');
    const result = parseWisdomFile(tmpDir);
    assert.ok(result !== null);
    assert.ok(result.paragraph.includes('Line one.'));
    assert.ok(result.paragraph.includes('Line three.'));
  });
});

// ─── routeWisdomCapture — None ────────────────────────────────────────────────

describe('routeWisdomCapture — None target', () => {
  test('returns fileModified: null without touching any files', () => {
    const wisdom: WisdomCapture = { target: 'None', paragraph: 'Nothing.' };
    const result = routeWisdomCapture(wisdom, 'TEST-001', tmpDir);
    assert.equal(result.fileModified, null);
  });
});

// ─── routeWisdomCapture — T4 ──────────────────────────────────────────────────

describe('routeWisdomCapture — T4 target', () => {
  beforeEach(() => {
    const diagDir = resolve(tmpDir, 'diagnostic-memory');
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(resolve(diagDir, 'INDEX.md'), '# Index\n');
    _setDiagMemoryDir(diagDir);
  });

  test('creates a T4 file in diagMemoryDir', () => {
    const wisdom: WisdomCapture = {
      target: 'T4',
      paragraph: 'The spawn timeout was caused by grandchildren holding the pipe open.',
      slug: 'spawn-timeout-lesson',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-042', tmpDir);
    assert.ok(result.fileModified !== null);
    assert.ok(result.fileModified.includes('spawn-timeout-lesson'));
    assert.ok(result.fileModified.endsWith('.md'));
  });

  test('T4 file includes the paragraph content', () => {
    const wisdom: WisdomCapture = {
      target: 'T4',
      paragraph: 'Lesson: always use detached spawn.',
      slug: 'spawn-lesson',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-043', tmpDir);
    assert.ok(result.fileModified !== null);
    assert.ok(existsSync(result.fileModified));
    const content = readFileSync(result.fileModified, 'utf8');
    assert.ok(content.includes('Lesson: always use detached spawn.'));
    assert.ok(content.includes('TASK-043'));
  });

  test('T4 route appends a row to INDEX.md', () => {
    const diagDir = resolve(tmpDir, 'diagnostic-memory');
    const wisdom: WisdomCapture = {
      target: 'T4',
      paragraph: 'Index test lesson.',
      slug: 'index-test',
    };
    routeWisdomCapture(wisdom, 'TASK-044', tmpDir);
    const index = readFileSync(resolve(diagDir, 'INDEX.md'), 'utf8');
    assert.ok(index.includes('index-test'));
    assert.ok(index.includes('TASK-044'));
  });

  test('T4 filename uses task id when slug is absent', () => {
    const wisdom: WisdomCapture = { target: 'T4', paragraph: 'Auto-slug test.' };
    const result = routeWisdomCapture(wisdom, 'MY-TASK-99', tmpDir);
    assert.ok(result.fileModified !== null);
    assert.ok(result.fileModified.includes('my-task-99'));
  });

  test('returns fileModified: null when diagMemoryDir cannot be written', () => {
    _setDiagMemoryDir('/nonexistent-dir-that-cannot-be-created-ever/subdir');
    const wisdom: WisdomCapture = { target: 'T4', paragraph: 'Will fail.', slug: 'fail' };
    const result = routeWisdomCapture(wisdom, 'TASK-X', tmpDir);
    assert.equal(result.fileModified, null);
  });
});

// ─── routeWisdomCapture — T2/T3 ───────────────────────────────────────────────

describe('routeWisdomCapture — T2/T3 target', () => {
  test('appends to an existing doc at a relative path', () => {
    const docPath = resolve(tmpDir, 'CLAUDE.md');
    writeFileSync(docPath, '# Existing content\n');
    const wisdom: WisdomCapture = {
      target: 'T2',
      path: 'CLAUDE.md',
      paragraph: 'New T2 lesson.',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-T2', tmpDir);
    assert.equal(result.fileModified, docPath);
    const content = readFileSync(docPath, 'utf8');
    assert.ok(content.includes('# Existing content'));
    assert.ok(content.includes('New T2 lesson.'));
    assert.ok(content.includes('pending operator review'));
    assert.ok(content.includes('TASK-T2'));
  });

  test('appends to T3 sub-app CLAUDE.md', () => {
    mkdirSync(resolve(tmpDir, 'apps', 'foo'), { recursive: true });
    const docPath = resolve(tmpDir, 'apps', 'foo', 'CLAUDE.md');
    writeFileSync(docPath, '# Sub-app doc\n');
    const wisdom: WisdomCapture = {
      target: 'T3',
      path: 'apps/foo/CLAUDE.md',
      paragraph: 'T3 sub-app lesson.',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-T3', tmpDir);
    assert.equal(result.fileModified, docPath);
    const content = readFileSync(docPath, 'utf8');
    assert.ok(content.includes('T3 sub-app lesson.'));
  });

  test('returns fileModified: null when path is absent', () => {
    const wisdom: WisdomCapture = { target: 'T2', paragraph: 'No path.' };
    const result = routeWisdomCapture(wisdom, 'TASK-X', tmpDir);
    assert.equal(result.fileModified, null);
  });

  test('returns fileModified: null when target path does not exist', () => {
    const wisdom: WisdomCapture = {
      target: 'T2',
      path: 'nonexistent.md',
      paragraph: 'Missing file.',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-X', tmpDir);
    assert.equal(result.fileModified, null);
  });
});

// ─── routeWisdomCapture — Personality ─────────────────────────────────────────

describe('routeWisdomCapture — Personality target', () => {
  test('appends to developer-personality.md', () => {
    const personalityPath = resolve(tmpDir, 'developer-personality.md');
    writeFileSync(personalityPath, '# Personality\n');
    _setDeveloperPersonalityPath(personalityPath);
    const wisdom: WisdomCapture = {
      target: 'Personality',
      paragraph: 'Always use snake_case for new DB columns.',
    };
    const result = routeWisdomCapture(wisdom, 'TASK-PERS', tmpDir);
    assert.equal(result.fileModified, personalityPath);
    const content = readFileSync(personalityPath, 'utf8');
    assert.ok(content.includes('snake_case'));
    assert.ok(content.includes('pending operator review'));
    assert.ok(content.includes('TASK-PERS'));
  });

  test('returns fileModified: null when personality doc does not exist', () => {
    _setDeveloperPersonalityPath(resolve(tmpDir, 'nonexistent.md'));
    const wisdom: WisdomCapture = { target: 'Personality', paragraph: 'No doc.' };
    const result = routeWisdomCapture(wisdom, 'TASK-X', tmpDir);
    assert.equal(result.fileModified, null);
  });
});

// ─── buildWisdomPrompt ─────────────────────────────────────────────────────────

describe('buildWisdomPrompt', () => {
  test('returns a non-empty string', () => {
    const prompt = buildWisdomPrompt();
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 100);
  });

  test('mentions NYX_WISDOM.md', () => {
    assert.ok(buildWisdomPrompt().includes('NYX_WISDOM.md'));
  });

  test('advertises Graph as the default target + None', () => {
    const prompt = buildWisdomPrompt();
    assert.ok(prompt.includes('Graph'), 'prompt should advertise the Graph target');
    assert.ok(prompt.includes('None'), 'prompt should keep the None opt-out');
    assert.ok(prompt.includes('memory/nodes'), 'prompt should point at the vault node path');
    for (const field of ['"id"', '"kind"', '"scope"', '"summary"']) {
      assert.ok(prompt.includes(field), `prompt should document the ${field} node field`);
    }
  });

  test('includes the json fence format example', () => {
    assert.ok(buildWisdomPrompt().includes('```json'));
  });
});

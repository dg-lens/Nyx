import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildComposeTemplatePrompt,
  parseTemplateOutput,
  validateComposedTemplate,
  writeTemplateIntoStore,
  type StoredTemplate,
} from '../src/template-composer.js';

const NOW = '2026-06-11T00:00:00.000Z';

function composed(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: 'Morning repo sweep',
    kind: 'task',
    text: 'Scan the repo for stale TODOs and report them.',
    type: 'analysis',
    model: 'sonnet',
    gate: 'none',
    priority: 'normal',
    repo: 'lens-cx/employee-portal',
    schedule: 'every:6h',
    ...overrides,
  };
}

describe('buildComposeTemplatePrompt', () => {
  test('embeds the prompt, the kind, and the output markers', () => {
    const p = buildComposeTemplatePrompt({ prompt: 'a daily slack digest template', kind: 'workflow' });
    assert.match(p, /Requested kind: workflow/);
    assert.match(p, /a daily slack digest template/);
    assert.match(p, /<<<TEMPLATE/);
    assert.match(p, /TEMPLATE>>>/);
  });

  test('unknown kind defaults to task', () => {
    assert.match(buildComposeTemplatePrompt({ prompt: 'x', kind: 'banana' }), /Requested kind: task/);
  });
});

describe('parseTemplateOutput', () => {
  test('extracts the marker-fenced JSON object', () => {
    const out = `noise\n<<<TEMPLATE\n${JSON.stringify(composed())}\nTEMPLATE>>>\ntrailing`;
    const raw = parseTemplateOutput(out) as Record<string, unknown>;
    assert.equal(raw.name, 'Morning repo sweep');
  });

  test('salvages a bare JSON object when markers were dropped', () => {
    const raw = parseTemplateOutput(`Here it is: ${JSON.stringify(composed())}`) as Record<string, unknown>;
    assert.equal(raw.type, 'analysis');
  });

  test('returns null for non-JSON output', () => {
    assert.equal(parseTemplateOutput('I could not produce a template.'), null);
  });

  test('returns null for malformed JSON inside markers', () => {
    assert.equal(parseTemplateOutput('<<<TEMPLATE\n{ not json\nTEMPLATE>>>'), null);
  });
});

describe('validateComposedTemplate', () => {
  test('valid object passes through with injected id/createdAt and forced source/folderId', () => {
    const t = validateComposedTemplate(composed(), { kind: 'task', nowIso: NOW, id: 'tpl-test' });
    assert.ok(t);
    assert.equal(t.id, 'tpl-test');
    assert.equal(t.createdAt, NOW);
    assert.equal(t.source, 'ai');
    assert.equal(t.folderId, null);
    assert.equal(t.repo, 'lens-cx/employee-portal');
    assert.equal(t.schedule, 'every:6h');
  });

  test('missing name or text rejects', () => {
    assert.equal(validateComposedTemplate(composed({ name: '' }), { nowIso: NOW }), null);
    assert.equal(validateComposedTemplate(composed({ text: '   ' }), { nowIso: NOW }), null);
    assert.equal(validateComposedTemplate('not an object', { nowIso: NOW }), null);
    assert.equal(validateComposedTemplate(null, { nowIso: NOW }), null);
  });

  test('workflow kind forces type pipeline (intent kind wins over the model output)', () => {
    const t = validateComposedTemplate(composed({ kind: 'task', type: 'code' }), { kind: 'workflow', nowIso: NOW });
    assert.ok(t);
    assert.equal(t.kind, 'workflow');
    assert.equal(t.type, 'pipeline');
  });

  test('type pipeline forces kind workflow (taxonomy: workflow ⟺ pipeline, even against intent)', () => {
    const drafted = validateComposedTemplate(composed({ kind: 'task', type: 'pipeline' }), { nowIso: NOW });
    assert.ok(drafted);
    assert.equal(drafted.kind, 'workflow');
    assert.equal(drafted.type, 'pipeline');

    const intentTask = validateComposedTemplate(composed({ kind: 'task', type: 'pipeline' }), { kind: 'task', nowIso: NOW });
    assert.ok(intentTask);
    assert.equal(intentTask.kind, 'workflow');
    assert.equal(intentTask.type, 'pipeline');
  });

  test('invalid enums fall back to defaults', () => {
    const t = validateComposedTemplate(
      composed({ type: 'banana', model: 'gpt', gate: 'vibes', priority: 'urgent' }),
      { kind: 'task', nowIso: NOW },
    );
    assert.ok(t);
    assert.equal(t.type, 'code');
    assert.equal(t.model, 'auto');
    assert.equal(t.gate, 'typecheck,tests');
    assert.equal(t.priority, 'normal');
  });

  test('gate accepts comma-joined stages and "none"', () => {
    const a = validateComposedTemplate(composed({ gate: 'typecheck,tests' }), { nowIso: NOW });
    const b = validateComposedTemplate(composed({ gate: 'none' }), { nowIso: NOW });
    assert.equal(a?.gate, 'typecheck,tests');
    assert.equal(b?.gate, 'none');
  });

  test('malformed repo and schedule drop to null', () => {
    const t = validateComposedTemplate(
      composed({ repo: 'not a repo', schedule: 'every:soon' }),
      { nowIso: NOW },
    );
    assert.ok(t);
    assert.equal(t.repo, null);
    assert.equal(t.schedule, null);
  });

  test('slot schedule is range-checked against the 288-slot day', () => {
    assert.equal(validateComposedTemplate(composed({ schedule: 'slot:287' }), { nowIso: NOW })?.schedule, 'slot:287');
    assert.equal(validateComposedTemplate(composed({ schedule: 'slot:288' }), { nowIso: NOW })?.schedule, null);
  });
});

describe('writeTemplateIntoStore', () => {
  function tpl(id: string): StoredTemplate {
    return validateComposedTemplate(composed(), { kind: 'task', nowIso: NOW, id })!;
  }

  test('missing file seeds a fresh v1 doc with the template appended', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nyx-tpl-')), 'templates.json');
    writeTemplateIntoStore(path, tpl('tpl-a'));
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.folders, []);
    assert.equal(doc.templates.length, 1);
    assert.equal(doc.templates[0].id, 'tpl-a');
    assert.equal(existsSync(`${path}.tmp`), false);
  });

  test('appends to an existing doc, preserving folders and unknown fields', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nyx-tpl-')), 'templates.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      folders: [{ id: 'f1', name: 'Daily', order: 0 }],
      templates: [{ id: 'tpl-existing', name: 'Old', kind: 'task', text: 'x' }],
      futureField: true,
    }));
    writeTemplateIntoStore(path, tpl('tpl-b'));
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(doc.templates.length, 2);
    assert.equal(doc.templates[1].id, 'tpl-b');
    assert.equal(doc.folders[0].id, 'f1');
    assert.equal(doc.futureField, true);
  });

  test('corrupt existing file throws and is preserved byte-for-byte', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nyx-tpl-')), 'templates.json');
    writeFileSync(path, '{ definitely not json');
    assert.throws(() => writeTemplateIntoStore(path, tpl('tpl-c')), /refusing to overwrite/);
    assert.equal(readFileSync(path, 'utf8'), '{ definitely not json');
  });

  test('non-object doc shape throws rather than clobbering', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nyx-tpl-')), 'templates.json');
    writeFileSync(path, '[1,2,3]');
    assert.throws(() => writeTemplateIntoStore(path, tpl('tpl-d')), /unexpected shape/);
    assert.equal(readFileSync(path, 'utf8'), '[1,2,3]');
  });
});

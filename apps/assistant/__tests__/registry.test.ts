import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  REGISTRY,
  findTemplate,
  TEMPLATE_TYPES,
  TEMPLATE_CATALOG,
  isTemplateId,
  templateTypeOf,
} from '../src/index.js';

const EXPECT: Record<string, string[]> = {
  'MORNING-BRIEF': ['ASSISTANT_OUTPUT.md', 'Brief'],
  'CALENDAR-SYNC': ['ASSISTANT_OUTPUT.md', 'Calendar'],
  'REMINDER': ['ASSISTANT_OUTPUT.md', 'Reminder'],
  'SLACK-DIGEST': ['ASSISTANT_OUTPUT.md', 'Slack'],
  'INBOX-TRIAGE': ['ASSISTANT_OUTPUT.md', 'Urgent'],
  'ROTATION-CHECK': ['ASSISTANT_OUTPUT.md', 'Rotation'],

  'DIGEST-SALES': ['ASSISTANT_OUTPUT.md', 'Sales Digest', 'MCP'],
  'DIGEST-MARKETING': ['ASSISTANT_OUTPUT.md', 'Marketing Digest', 'MCP'],
  'DIGEST-OPS': ['ASSISTANT_OUTPUT.md', 'Ops Digest', 'MCP'],

  'BRIEF-COMPETITOR': ['ASSISTANT_OUTPUT.md', 'Competitor Brief', 'WebSearch', 'source'],
  'BRIEF-PROSPECT': ['ASSISTANT_OUTPUT.md', 'Prospect Brief', 'WebSearch', 'source'],
  'BRIEF-MARKET': ['ASSISTANT_OUTPUT.md', 'Market Brief', 'WebSearch', 'source'],

  'DRAFT-OUTREACH': ['outreach-draft.md', 'DRAFT', '<TokenName>'],
  'DRAFT-FOLLOWUP': ['followup-draft.md', 'DRAFT', '<TokenName>'],
  'DRAFT-RELEASE-NOTES': ['release-notes-draft.md', 'DRAFT', '<TokenName>'],
  'DRAFT-SOCIAL': ['social-draft.md', 'DRAFT', '<TokenName>'],

  'TRIAGE-SLACK': ['ASSISTANT_OUTPUT.md', 'Urgent', 'DRAFT'],
  'TRIAGE-NOTION': ['ASSISTANT_OUTPUT.md', 'Urgent', 'DRAFT'],
  'TRIAGE-ALL': ['ASSISTANT_OUTPUT.md', 'Urgent', 'DRAFT'],

  'DECK-INVESTOR-UPDATE': ['investor-update-draft.md', 'DRAFT', '<TokenName>'],
  'DOC-WEEKLY-REPORT': ['weekly-report-draft.md', 'DRAFT'],
  'SHEET-PIPELINE-EXPORT': ['pipeline-export.csv'],

  'MEETING-PREP': ['ASSISTANT_OUTPUT.md', 'Meeting Prep'],
  'MEETING-FOLLOWUP': ['ASSISTANT_OUTPUT.md', 'DRAFT'],

  'WATCH-DEPS': ['ASSISTANT_OUTPUT.md', 'Dependency Watch'],
  'WATCH-DEADCODE': ['ASSISTANT_OUTPUT.md', 'Dead Code Watch'],
  'WATCH-COST': ['ASSISTANT_OUTPUT.md', 'Cost Watch'],
};

describe('REGISTRY', () => {
  test('every registry entry resolves via findTemplate to the same builder', () => {
    for (const key of Object.keys(REGISTRY)) {
      const resolved = findTemplate(key);
      assert.equal(resolved, REGISTRY[key], `findTemplate('${key}') must return the registered builder`);
    }
  });

  test('every registry entry resolves with a slotted/suffixed task id (prefix match)', () => {
    for (const key of Object.keys(REGISTRY)) {
      const resolved = findTemplate(`${key}-001`);
      assert.ok(resolved, `findTemplate('${key}-001') must resolve via prefix match`);
    }
  });

  test('every registry entry returns a non-empty prompt', () => {
    for (const key of Object.keys(REGISTRY)) {
      const prompt = REGISTRY[key]!('test task description');
      assert.ok(prompt.trim().length > 100, `${key} prompt must be substantive`);
      assert.ok(
        prompt.includes('test task description'),
        `${key} should weave in the task description`,
      );
    }
  });

  test('every registry entry mentions its key output channel/artifact', () => {
    for (const [key, needles] of Object.entries(EXPECT)) {
      const builder = REGISTRY[key];
      assert.ok(builder, `EXPECT references unknown registry key '${key}'`);
      const prompt = builder('test task description');
      for (const needle of needles) {
        assert.ok(
          prompt.includes(needle),
          `${key} prompt must mention '${needle}'`,
        );
      }
    }
  });

  test('EXPECT covers every registry key (no template ships untested)', () => {
    for (const key of Object.keys(REGISTRY)) {
      assert.ok(key in EXPECT, `registry key '${key}' has no EXPECT coverage`);
    }
  });

  test('findTemplate returns null for an unknown id', () => {
    assert.equal(findTemplate('TOTALLY-UNKNOWN-TASK'), null);
  });
});

describe('TEMPLATE_TYPES (single source of truth)', () => {
  test('every REGISTRY key has a TEMPLATE_TYPES entry and vice-versa', () => {
    const reg = new Set(Object.keys(REGISTRY));
    const typed = new Set(Object.keys(TEMPLATE_TYPES));
    for (const k of reg) assert.ok(typed.has(k), `${k} in REGISTRY has no TEMPLATE_TYPES entry`);
    for (const k of typed) assert.ok(reg.has(k), `${k} in TEMPLATE_TYPES has no REGISTRY builder`);
  });

  test('every type is assistant or content', () => {
    for (const [k, v] of Object.entries(TEMPLATE_TYPES)) {
      assert.ok(v === 'assistant' || v === 'content', `${k} maps to an unexpected type '${v}'`);
    }
  });

  test('DRAFT-/DECK-/DOC-/SHEET- families are content; the rest are assistant', () => {
    for (const [k, v] of Object.entries(TEMPLATE_TYPES)) {
      const isContent = /^(DRAFT|DECK|DOC|SHEET)-/.test(k);
      assert.equal(v, isContent ? 'content' : 'assistant', `${k} type classification`);
    }
  });

  test('isTemplateId / templateTypeOf agree with the map', () => {
    assert.ok(isTemplateId('BRIEF-COMPETITOR'));
    assert.ok(!isTemplateId('NOT-A-TEMPLATE'));
    assert.equal(templateTypeOf('DRAFT-OUTREACH'), 'content');
    assert.equal(templateTypeOf('WATCH-DEPS'), 'assistant');
    assert.equal(templateTypeOf('NOPE'), null);
  });
});

describe('TEMPLATE_CATALOG (catalog <-> registry)', () => {
  test('every REGISTRY key has a catalog entry and vice-versa', () => {
    const reg = new Set(Object.keys(REGISTRY));
    const cat = new Set(Object.keys(TEMPLATE_CATALOG));
    for (const k of reg) assert.ok(cat.has(k), `${k} in REGISTRY has no TEMPLATE_CATALOG entry`);
    for (const k of cat) assert.ok(reg.has(k), `${k} in TEMPLATE_CATALOG has no REGISTRY builder`);
  });

  test('every catalog entry has a non-empty blurb, valid type, and inputs array', () => {
    for (const [k, entry] of Object.entries(TEMPLATE_CATALOG)) {
      assert.ok(
        typeof entry.blurb === 'string' && entry.blurb.trim().length > 0,
        `${k} must have a non-empty blurb`,
      );
      assert.ok(entry.blurb.length < 90, `${k} blurb must be under 90 chars (got ${entry.blurb.length})`);
      assert.ok(
        entry.type === 'assistant' || entry.type === 'content',
        `${k} maps to an unexpected type '${entry.type}'`,
      );
      assert.ok(Array.isArray(entry.inputs), `${k} inputs must be an array`);
      for (const input of entry.inputs) {
        assert.ok(
          typeof input === 'string' && input.trim().length > 0,
          `${k} has an empty input label`,
        );
      }
    }
  });

  test('TEMPLATE_TYPES is derived from the catalog (types match for every id)', () => {
    const typed = new Set(Object.keys(TEMPLATE_TYPES));
    const cat = new Set(Object.keys(TEMPLATE_CATALOG));
    for (const k of cat) assert.ok(typed.has(k), `${k} in catalog missing from TEMPLATE_TYPES`);
    for (const k of typed) assert.ok(cat.has(k), `${k} in TEMPLATE_TYPES missing from catalog`);
    for (const [k, entry] of Object.entries(TEMPLATE_CATALOG)) {
      assert.equal(TEMPLATE_TYPES[k], entry.type, `${k} type must match the catalog`);
    }
  });
});

/**
 * Tests for the content-judge (P7 independent advisory verifier).
 *
 * Cover the parse of the NYX_JUDGE.md envelope, the confidence-threshold concern
 * gate (a low-confidence FAIL is suppressed), the CoT-and-dimensions structure
 * of the prompt, and the summary line.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  JUDGE_CONFIDENCE_THRESHOLD,
  buildJudgePrompt,
  isJudgeConcern,
  parseJudgeContent,
  summarizeJudgement,
} from '../src/content-judge.js';
import type { ParsedTask } from '../src/types.js';

function mkTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: 'JUDGE-1',
    description: 'Add a rate limiter to the auth endpoint.',
    type: 'code',
    model: 'sonnet',
    gates: ['typecheck', 'tests'],
    priority: 'normal',
    checked: false,
    rawLines: [],
    startLine: 0,
    endLine: 0,
    invalidTags: [],
    ...overrides,
  };
}

const FENCE = (json: string, prose = 'reasoning here'): string =>
  ['```json', json, '```', '', prose].join('\n');

describe('parseJudgeContent', () => {
  test('parses a well-formed PASS envelope', () => {
    const j = parseJudgeContent(
      FENCE(
        JSON.stringify({
          verdict: 'PASS',
          confidence: 90,
          score: 88,
          dimensions: [
            { name: 'spec-conformance', score: 90 },
            { name: 'correctness', score: 85 },
          ],
          rationale: 'does what was asked',
        }),
        'It implements the limiter at the right place.',
      ),
    );
    assert.ok(j);
    assert.equal(j!.verdict, 'PASS');
    assert.equal(j!.confidence, 90);
    assert.equal(j!.dimensions.length, 2);
    assert.ok(j!.analysis.includes('right place'));
  });

  test('uppercases a lowercase verdict', () => {
    const j = parseJudgeContent(FENCE(JSON.stringify({ verdict: 'fail', confidence: 80 })));
    assert.equal(j?.verdict, 'FAIL');
  });

  test('clamps out-of-range scores', () => {
    const j = parseJudgeContent(FENCE(JSON.stringify({ verdict: 'PASS', confidence: 250, score: -5 })));
    assert.equal(j?.confidence, 100);
    assert.equal(j?.score, 0);
  });

  test('returns null on a missing fence', () => {
    assert.equal(parseJudgeContent('no json here'), null);
  });
  test('returns null on bad JSON', () => {
    assert.equal(parseJudgeContent(FENCE('{not json')), null);
  });
  test('returns null on an invalid verdict', () => {
    assert.equal(parseJudgeContent(FENCE(JSON.stringify({ verdict: 'MAYBE' }))), null);
  });
});

describe('parseJudgeContent — deliverable checklist (parts)', () => {
  test('round-trips a parts array and derives the present/total counts', () => {
    const j = parseJudgeContent(
      FENCE(
        JSON.stringify({
          verdict: 'FAIL',
          confidence: 88,
          score: 55,
          dimensions: [{ name: 'spec-conformance', score: 60 }],
          parts: [
            { name: 'parser round-trips parts', present: true },
            { name: 'prompt contains checklist instruction', present: true },
            { name: 'fraction math fixture', present: false },
            { name: 'backward-compatible parse', present: false },
            { name: 'CHANGELOG entry', present: true },
          ],
          rationale: 'two of five parts missing',
        }),
      ),
    );
    assert.ok(j);
    assert.equal(j!.parts.length, 5);
    assert.equal(j!.parts[0]!.name, 'parser round-trips parts');
    assert.equal(j!.parts[0]!.present, true);
    assert.equal(j!.partsPresent, 3);
    assert.equal(j!.partsTotal, 5);
  });

  test('a verdict with NO parts field still parses (backward compatible)', () => {
    const j = parseJudgeContent(
      FENCE(
        JSON.stringify({
          verdict: 'PASS',
          confidence: 90,
          score: 88,
          dimensions: [{ name: 'spec-conformance', score: 90 }],
          rationale: 'pre-checklist verdict shape',
        }),
      ),
    );
    assert.ok(j);
    assert.deepEqual(j!.parts, []);
    assert.equal(j!.partsPresent, 0);
    assert.equal(j!.partsTotal, 0);
  });

  test('coerces a non-array parts field to [] rather than crashing', () => {
    const j = parseJudgeContent(
      FENCE(JSON.stringify({ verdict: 'PASS', confidence: 70, parts: 'not-an-array' })),
    );
    assert.ok(j);
    assert.deepEqual(j!.parts, []);
    assert.equal(j!.partsTotal, 0);
  });

  test('a non-true present value counts as absent', () => {
    const j = parseJudgeContent(
      FENCE(
        JSON.stringify({
          verdict: 'FAIL',
          confidence: 80,
          parts: [
            { name: 'a', present: true },
            { name: 'b', present: 'yes' },
            { name: 'c' },
          ],
        }),
      ),
    );
    assert.ok(j);
    assert.equal(j!.partsTotal, 3);
    assert.equal(j!.partsPresent, 1);
  });

  test('fraction math: 3 of 5 present → present=3 total=5', () => {
    const parts = [true, true, false, true, false].map((present, i) => ({ name: `p${i}`, present }));
    const j = parseJudgeContent(FENCE(JSON.stringify({ verdict: 'FAIL', confidence: 80, parts })));
    assert.ok(j);
    assert.equal(j!.partsPresent, 3);
    assert.equal(j!.partsTotal, 5);
  });
});

describe('isJudgeConcern — threshold gate', () => {
  const base = { score: 40, dimensions: [], parts: [], partsPresent: 0, partsTotal: 0, analysis: '', rationale: '' };
  test('a confident FAIL is a concern', () => {
    assert.equal(isJudgeConcern({ verdict: 'FAIL', confidence: 90, ...base }), true);
  });
  test('a low-confidence FAIL is suppressed (noise)', () => {
    assert.equal(isJudgeConcern({ verdict: 'FAIL', confidence: 50, ...base }), false);
  });
  test('a PASS is never a concern, even at high confidence', () => {
    assert.equal(isJudgeConcern({ verdict: 'PASS', confidence: 99, ...base }), false);
  });
  test('exactly at threshold counts', () => {
    assert.equal(
      isJudgeConcern({ verdict: 'FAIL', confidence: JUDGE_CONFIDENCE_THRESHOLD, ...base }),
      true,
    );
  });
});

describe('buildJudgePrompt — bias mitigations are structural', () => {
  const prompt = buildJudgePrompt(mkTask());
  test('embeds the acceptance criteria', () => {
    assert.ok(prompt.includes('Add a rate limiter to the auth endpoint.'));
  });
  test('demands CoT before the verdict', () => {
    assert.ok(/reason step by step before you decide/i.test(prompt));
  });
  test('names the four scoring dimensions', () => {
    for (const d of ['spec-conformance', 'correctness', 'completeness', 'no-regression']) {
      assert.ok(prompt.includes(d), `missing dimension ${d}`);
    }
  });
  test('names the output file + exit-0 contract', () => {
    assert.ok(prompt.includes('NYX_JUDGE.md'));
    assert.ok(/exit 0/.test(prompt));
  });
});

describe('buildJudgePrompt — absence-aware checklist', () => {
  test('instructs the judge to build the deliverables checklist before scoring', () => {
    const prompt = buildJudgePrompt(mkTask());
    assert.ok(/deliverables checklist/i.test(prompt), 'missing checklist instruction');
    assert.ok(/present \(true\) or absent \(false\)/i.test(prompt), 'missing present/absent marking');
    // The instruction must precede the dimension scoring block.
    assert.ok(
      prompt.indexOf('DELIVERABLES CHECKLIST') < prompt.indexOf('Score these four dimensions'),
      'checklist instruction must come BEFORE dimension scoring',
    );
  });

  test('ties spec-conformance to the fraction present with the 60-cap rule', () => {
    const prompt = buildJudgePrompt(mkTask());
    assert.ok(/fraction of deliverables/i.test(prompt));
    assert.ok(/parts_present \/ parts_total/i.test(prompt));
    assert.ok(/missing 2 of 5 parts cannot score above 60/i.test(prompt));
  });

  test('asks for a parts array in the output JSON schema', () => {
    const prompt = buildJudgePrompt(mkTask());
    assert.ok(/"parts":/.test(prompt));
    assert.ok(/"present": true \| false/.test(prompt));
  });

  test('embeds the [expects:] paths when the task declares them', () => {
    const prompt = buildJudgePrompt(
      mkTask({ expects: ['migrations/0003_x.sql', 'src/admin/page.tsx'] }),
    );
    assert.ok(prompt.includes('migrations/0003_x.sql'));
    assert.ok(prompt.includes('src/admin/page.tsx'));
    assert.ok(/\[expects:\]/.test(prompt));
  });

  test('does not crash and omits the expects block when [expects:] is absent', () => {
    const prompt = buildJudgePrompt(mkTask({ expects: undefined }));
    assert.ok(!/Declared `\[expects:\]` artifacts/.test(prompt));
    // Still derives parts from spec text — the checklist instruction is present regardless.
    assert.ok(/DELIVERABLES CHECKLIST/.test(prompt));
  });

  test('omits the expects block for an empty [expects:] array', () => {
    const prompt = buildJudgePrompt(mkTask({ expects: [] }));
    assert.ok(!/Declared `\[expects:\]` artifacts/.test(prompt));
  });
});

describe('summarizeJudgement', () => {
  test('surfaces verdict, confidence, and the weakest dimension', () => {
    const s = summarizeJudgement({
      verdict: 'FAIL',
      confidence: 85,
      score: 60,
      dimensions: [
        { name: 'spec-conformance', score: 80 },
        { name: 'completeness', score: 30 },
      ],
      parts: [],
      partsPresent: 0,
      partsTotal: 0,
      analysis: '',
      rationale: 'missing the limiter on the refresh path',
    });
    assert.ok(s.includes('FAIL'));
    assert.ok(s.includes('conf=85'));
    assert.ok(s.includes('completeness:30'));
    assert.ok(s.includes('refresh path'));
  });

  test('surfaces the parts ratio when the checklist is present', () => {
    const s = summarizeJudgement({
      verdict: 'FAIL',
      confidence: 88,
      score: 55,
      dimensions: [{ name: 'spec-conformance', score: 60 }],
      parts: [
        { name: 'a', present: true },
        { name: 'b', present: true },
        { name: 'c', present: true },
        { name: 'd', present: false },
        { name: 'e', present: false },
      ],
      partsPresent: 3,
      partsTotal: 5,
      analysis: '',
      rationale: 'two parts absent',
    });
    assert.ok(s.includes('parts=3/5'));
  });

  test('omits the parts ratio when there is no checklist', () => {
    const s = summarizeJudgement({
      verdict: 'PASS',
      confidence: 90,
      score: 88,
      dimensions: [{ name: 'spec-conformance', score: 90 }],
      parts: [],
      partsPresent: 0,
      partsTotal: 0,
      analysis: '',
      rationale: 'all good',
    });
    assert.ok(!s.includes('parts='));
  });
});

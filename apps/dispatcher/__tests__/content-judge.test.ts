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

describe('isJudgeConcern — threshold gate', () => {
  const base = { score: 40, dimensions: [], analysis: '', rationale: '' };
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
      analysis: '',
      rationale: 'missing the limiter on the refresh path',
    });
    assert.ok(s.includes('FAIL'));
    assert.ok(s.includes('conf=85'));
    assert.ok(s.includes('completeness:30'));
    assert.ok(s.includes('refresh path'));
  });
});

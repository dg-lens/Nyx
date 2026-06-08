import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision, defaultOptions, NOTE_REQUIRED, PREVIEW_VERBS, REVIEW_VERBS } from '../src/gate-relay.ts';

test('defaultOptions by gate kind', () => {
  assert.deepEqual(defaultOptions('preview'), PREVIEW_VERBS);
  assert.deepEqual(defaultOptions('review'), REVIEW_VERBS);
  assert.deepEqual(defaultOptions('anything-else'), REVIEW_VERBS);
});

test('validateDecision rejects a verb not in options', () => {
  const r = validateDecision(['go', 'abort'], 'proceed', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not allowed/);
});

test('validateDecision accepts an allowed verb', () => {
  assert.deepEqual(validateDecision(['go', 'revise', 'abort'], 'go', undefined), { ok: true });
});

test('revise + fix require a note', () => {
  assert.ok(NOTE_REQUIRED.has('revise'));
  assert.ok(NOTE_REQUIRED.has('fix'));
  const noNote = validateDecision(['go', 'revise', 'abort'], 'revise', '   ');
  assert.equal(noNote.ok, false);
  const withNote = validateDecision(['go', 'revise', 'abort'], 'revise', 'tighten the schema');
  assert.deepEqual(withNote, { ok: true });
});

test('go/proceed/abort do not require a note', () => {
  assert.deepEqual(validateDecision(REVIEW_VERBS, 'proceed', undefined), { ok: true });
  assert.deepEqual(validateDecision(REVIEW_VERBS, 'abort', undefined), { ok: true });
});

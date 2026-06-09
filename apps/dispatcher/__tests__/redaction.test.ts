import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { redactCredentialPatterns, redactValues } from '../src/redaction.js';

describe('redactValues — per-task injected secret VALUES', () => {
  test('scrubs an injected Bitwarden value out of subprocess output', () => {
    const secret = 'postgres://user:supersecretpw@db.example.com:5432/app';
    const text = `connecting...\nfatal: could not reach ${secret}\nretry`;
    const out = redactValues(text, [secret]);
    assert.doesNotMatch(out, /supersecretpw/);
    assert.match(out, /\[REDACTED\]/);
  });

  test('scrubs every value in the injected set', () => {
    const a = 'value-aaaaaaaa';
    const b = 'value-bbbbbbbb';
    const out = redactValues(`${a} and ${b} leaked`, [a, b]);
    assert.doesNotMatch(out, /value-a/);
    assert.doesNotMatch(out, /value-b/);
  });

  test('ignores short values to avoid scrubbing innocuous substrings', () => {
    const out = redactValues('the cwd is /tmp/abc', ['abc']);
    assert.match(out, /\/tmp\/abc/);
  });

  test('empty / falsy values are no-ops', () => {
    assert.equal(redactValues('hello', ['']), 'hello');
    assert.equal(redactValues('', ['x'.repeat(20)]), '');
  });
});

describe('redactCredentialPatterns — generic credential backstop', () => {
  const cases: Array<[string, string]> = [
    ['fine-grained github_pat_', 'github_pat_11ABCDE0Y0abcdefghij_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQ'],
    ['classic ghp_', 'ghp_' + 'A'.repeat(36)],
    ['oauth gho_', 'gho_' + 'B'.repeat(36)],
    ['server-to-server ghs_', 'ghs_' + 'C'.repeat(36)],
    ['refresh ghr_', 'ghr_' + 'D'.repeat(36)],
    ['anthropic sk-ant-', 'sk-ant-api03-' + 'x'.repeat(40)],
    ['openai sk-', 'sk-' + 'Z'.repeat(40)],
    ['slack bot xoxb-', 'xoxb-1234567890-abcdefghij'],
    ['aws akia', 'AKIAIOSFODNN7EXAMPLE'],
  ];

  for (const [label, token] of cases) {
    test(`redacts ${label}`, () => {
      const out = redactCredentialPatterns(`before ${token} after`);
      assert.doesNotMatch(out, new RegExp(token.slice(0, 12)), `${label} not redacted: ${out}`);
      assert.match(out, /\[REDACTED\]/);
    });
  }

  test('fine-grained github_pat_ is NOT matched by the classic gh[posru]_ alternation alone', () => {
    const pat = 'github_pat_11ABCDE0Y0abcdefghij_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQ';
    assert.equal(/\bgh[posru]_[A-Za-z0-9]{20,}/.test(pat), false);
    assert.match(redactCredentialPatterns(pat), /^\[REDACTED\]$/);
  });

  test('leaves ordinary text untouched', () => {
    const text = 'building apps/dispatcher, running pnpm test, all green';
    assert.equal(redactCredentialPatterns(text), text);
  });
});

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { scrubDiagnosticResult } from '../src/audit-runner.js';

describe('scrubDiagnosticResult — M10 diagnostic-spawn secret scrub', () => {
  test('injected postgres:// connection string does NOT survive into the operator_report text', () => {
    const dbUrl = 'postgres://nyx:Sup3rSecretPw@db.internal.example.com:5432/app';
    const extraEnv = { SUPABASE_DB_URL: dbUrl, BWS_ACCESS_TOKEN: '0.abcdefgh.ijklmnopqrstuvwxyz' };

    const raw = {
      exitCode: 1,
      stdout: `VERDICT: halt: could not connect — tried ${dbUrl} and it refused`,
      stderr: `psql: error: connection to ${dbUrl} failed`,
    };

    const result = scrubDiagnosticResult(raw, extraEnv);

    const operatorReport =
      `Diagnostic agent produced an unparseable verdict. Raw output:\n\n${result.stdout.slice(0, 2000)}\n\nStderr:\n\n${result.stderr.slice(0, 1000)}`;

    assert.doesNotMatch(operatorReport, /Sup3rSecretPw/);
    assert.doesNotMatch(operatorReport, /db\.internal\.example\.com/);
    assert.doesNotMatch(operatorReport, /0\.abcdefgh\.ijklmnopqrstuvwxyz/);
    assert.match(operatorReport, /\[REDACTED\]/);
    assert.equal(result.exitCode, 1);
  });

  test('credential-shape backstop catches a token not present in extraEnv', () => {
    const raw = {
      exitCode: 0,
      stdout: 'leaked a stray token github_pat_11ABCDE0Y0abcdefghij_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQ in a stack trace',
      stderr: '',
    };
    const result = scrubDiagnosticResult(raw, {});
    assert.doesNotMatch(result.stdout, /github_pat_11ABCDE/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });

  test('leaves ordinary diagnostic output untouched', () => {
    const raw = { exitCode: 0, stdout: 'VERDICT: fixed — patched the import path', stderr: '' };
    const result = scrubDiagnosticResult(raw, { SUPABASE_DB_URL: 'postgres://u:p@h:5432/d' });
    assert.equal(result.stdout, 'VERDICT: fixed — patched the import path');
  });
});

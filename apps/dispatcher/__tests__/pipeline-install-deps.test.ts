import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { detectInstallCommands, installDeps } from '../src/pipeline/install-deps.js';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'nyx-inst-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

describe('detectInstallCommands', () => {
  test('package.json with no lockfile → npm install', () => {
    assert.deepEqual(detectInstallCommands(dir({ 'package.json': '{}' })), ['npm install']);
  });

  test('pnpm-lock.yaml → pnpm; yarn.lock → yarn (lockfile picks the manager)', () => {
    assert.deepEqual(
      detectInstallCommands(dir({ 'package.json': '{}', 'pnpm-lock.yaml': '' })),
      ['pnpm install --prefer-offline'],
    );
    assert.deepEqual(detectInstallCommands(dir({ 'package.json': '{}', 'yarn.lock': '' })), ['yarn install']);
  });

  test('@playwright/test in deps → adds a browser install after npm install', () => {
    const d = dir({ 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1' } }) });
    assert.deepEqual(detectInstallCommands(d), ['npm install', 'npx --yes playwright install chromium']);
  });

  test('no playwright → no browser install', () => {
    const d = dir({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
    assert.deepEqual(detectInstallCommands(d), ['npm install']);
  });

  test('pyproject.toml → uv sync; combined node + python', () => {
    assert.deepEqual(
      detectInstallCommands(dir({ 'pyproject.toml': '' })),
      ['uv sync --all-extras --all-groups --no-progress'],
    );
    assert.deepEqual(
      detectInstallCommands(dir({ 'package.json': '{}', 'pyproject.toml': '' })),
      ['npm install', 'uv sync --all-extras --all-groups --no-progress'],
    );
  });

  test('empty dir → nothing to install', () => {
    assert.deepEqual(detectInstallCommands(dir({})), []);
  });

  test('malformed package.json still installs (playwright detection just skips)', () => {
    const d = dir({ 'package.json': '{not json' });
    assert.deepEqual(detectInstallCommands(d), ['npm install']);
  });
});

describe('installDeps', () => {
  test('runs detected commands in order, in the base dir, and aggregates ok', () => {
    const d = dir({ 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1' } }) });
    const calls: Array<{ cmd: string; cwd: string }> = [];
    const res = installDeps(d, { exec: (cmd, cwd) => { calls.push({ cmd, cwd }); return { cmd, ok: true, log: '' }; } });
    assert.deepEqual(calls.map((c) => c.cmd), ['npm install', 'npx --yes playwright install chromium']);
    assert.ok(calls.every((c) => c.cwd === d), 'runs in the base dir');
    assert.equal(res.ok, true);
    assert.equal(res.ran.length, 2);
  });

  test('a failing command makes the overall result not-ok but still records every command', () => {
    const d = dir({ 'package.json': '{}' });
    const res = installDeps(d, { exec: (cmd) => ({ cmd, ok: false, log: 'ENOTFOUND registry' }) });
    assert.equal(res.ok, false);
    assert.equal(res.ran[0]?.ok, false);
    assert.match(res.ran[0]?.log ?? '', /ENOTFOUND/);
  });

  test('no-op (ok, empty) when there is nothing to install', () => {
    const res = installDeps(dir({}), { exec: () => { throw new Error('should not run'); } });
    assert.deepEqual(res, { ran: [], ok: true });
  });
});

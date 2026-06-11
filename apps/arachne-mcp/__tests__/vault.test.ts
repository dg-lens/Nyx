import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { IndexCache, isKegPath, resolveDataDir } from '../src/vault.js';
import { writeTool } from '../src/tools.js';

const SAVED_DATA = process.env['NYX_DATA_DIR'];
const SAVED_REPO = process.env['NYX_REPO_ROOT'];

function restoreEnv(): void {
  if (SAVED_DATA === undefined) delete process.env['NYX_DATA_DIR'];
  else process.env['NYX_DATA_DIR'] = SAVED_DATA;
  if (SAVED_REPO === undefined) delete process.env['NYX_REPO_ROOT'];
  else process.env['NYX_REPO_ROOT'] = SAVED_REPO;
}

describe('keg-path detection', () => {
  test('flags Cellar and libexec paths literally, even when not on disk', () => {
    assert.equal(isKegPath('/opt/homebrew/Cellar/nyx/1.2.1/libexec/memory'), true);
    assert.equal(isKegPath('/opt/homebrew/opt/nyx/libexec'), true);
    assert.equal(isKegPath('/usr/local/Cellar/nyx/0.9.0'), true);
  });

  test('accepts the canonical vault and plain temp dirs', () => {
    assert.equal(isKegPath(resolve(homedir(), 'Nyx', 'Data', 'memory')), false);
    assert.equal(isKegPath(mkdtempSync(join(tmpdir(), 'arachne-clean-'))), false);
  });

  test('sees through a symlink whose literal path looks clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'arachne-keg-'));
    const keg = join(root, 'Cellar', 'nyx', '1.0.0', 'memory');
    mkdirSync(keg, { recursive: true });
    const alias = join(root, 'vault');
    symlinkSync(keg, alias);
    assert.equal(isKegPath(alias), true, 'realpath reveals the Cellar target');
  });
});

describe('data dir resolution', () => {
  afterEach(restoreEnv);

  test('honors a clean NYX_DATA_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arachne-data-'));
    process.env['NYX_DATA_DIR'] = dir;
    assert.equal(resolveDataDir(), dir);
  });

  test('a keg-resident NYX_DATA_DIR is ignored — never resolves into the keg', () => {
    const root = mkdtempSync(join(tmpdir(), 'arachne-poison-'));
    const keg = join(root, 'Cellar', 'nyx', '9.9.9', 'libexec');
    mkdirSync(keg, { recursive: true });
    mkdirSync(join(root, 'Core'), { recursive: true });
    process.env['NYX_DATA_DIR'] = keg;
    process.env['NYX_REPO_ROOT'] = join(root, 'Core');
    const resolved = resolveDataDir();
    assert.equal(isKegPath(resolved), false, 'resolution escaped the keg');
    assert.equal(resolved, resolve(homedir(), 'Nyx', 'Data'), 'fell through to the canonical vault');
  });

  test('falls back to the repo-root sibling Data/ when env is unset', () => {
    const root = mkdtempSync(join(tmpdir(), 'arachne-sibling-'));
    mkdirSync(join(root, 'Core'), { recursive: true });
    mkdirSync(join(root, 'Data'), { recursive: true });
    delete process.env['NYX_DATA_DIR'];
    process.env['NYX_REPO_ROOT'] = join(root, 'Core');
    assert.equal(resolveDataDir(), join(root, 'Data'));
  });

  test('never falls back to the repo root itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'arachne-noroot-'));
    mkdirSync(join(root, 'Core'), { recursive: true });
    delete process.env['NYX_DATA_DIR'];
    process.env['NYX_REPO_ROOT'] = join(root, 'Core');
    assert.equal(resolveDataDir(), resolve(homedir(), 'Nyx', 'Data'));
  });
});

describe('keg write refusal', () => {
  test('memory_write into a keg-resident vault is a structured REJECT, nothing persisted', () => {
    const root = mkdtempSync(join(tmpdir(), 'arachne-kegvault-'));
    const dir = join(root, 'libexec', 'memory');
    mkdirSync(join(dir, 'nodes'), { recursive: true });
    const cache = new IndexCache(dir);
    const res = writeTool(cache, cache.vault, {
      id: 'doomed-node',
      kind: 'lesson',
      title: 'should never land',
      summary: 'a write into the keg must be refused, not persisted',
      loc: ['stack.nyx'],
      body: 'SYMPTOM: write landed in the keg.\nFIX: refuse.',
    });
    assert.equal(res.written, false, 'refused');
    assert.equal(res.action, 'REJECT');
    assert.match(res.reason, /keg-resident/);
    assert.equal(readdirSync(join(dir, 'nodes')).length, 0, 'no file written into the keg');
  });
});

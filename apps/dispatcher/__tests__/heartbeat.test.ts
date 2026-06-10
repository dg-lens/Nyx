import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { writeHeartbeat } from '../src/heartbeat.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('heartbeat — tick health signal', () => {
  test('writes a valid JSON file with at, pid, and slot fields', () => {
    const dest = join(dir, 'heartbeat.json');
    const before = Date.now();
    writeHeartbeat(7, dest);
    const after = Date.now();

    assert.ok(existsSync(dest));
    const raw = JSON.parse(readFileSync(dest, 'utf8'));
    assert.equal(typeof raw.at, 'string');
    assert.equal(raw.slot, 7);
    assert.equal(raw.pid, process.pid);
    const ts = new Date(raw.at).getTime();
    assert.ok(ts >= before && ts <= after, 'at must be within test bounds');
  });

  test('creates intermediate directories when they do not exist', () => {
    const dest = join(dir, 'nested', 'deep', 'heartbeat.json');
    assert.doesNotThrow(() => writeHeartbeat(3, dest));
    assert.ok(existsSync(dest));
  });

  test('overwrites an existing heartbeat file', () => {
    const dest = join(dir, 'heartbeat.json');
    writeHeartbeat(1, dest);
    writeHeartbeat(2, dest);
    const raw = JSON.parse(readFileSync(dest, 'utf8'));
    assert.equal(raw.slot, 2);
  });

  test('at is a valid ISO 8601 string', () => {
    const dest = join(dir, 'heartbeat.json');
    writeHeartbeat(0, dest);
    const { at } = JSON.parse(readFileSync(dest, 'utf8'));
    assert.ok(!Number.isNaN(new Date(at).getTime()), 'at must parse as a valid date');
    assert.ok(at.includes('T'), 'at must be ISO 8601 (contains T separator)');
  });
});

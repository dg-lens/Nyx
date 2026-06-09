import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { loadSettings, SETTINGS_DEFAULTS } from '../src/settings.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'nyx-settings-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(obj: unknown): void {
  writeFileSync(resolve(dir, 'settings.json'), JSON.stringify(obj));
}

describe('loadSettings — notifications defaults', () => {
  test('absent settings.json yields the default notifications block', () => {
    const s = loadSettings(dir);
    assert.deepEqual(s.notifications, SETTINGS_DEFAULTS.notifications);
  });

  test('a settings.json with no notifications key falls back to defaults', () => {
    write({ pipeline: { concurrentCap: 8 } });
    const s = loadSettings(dir);
    assert.deepEqual(s.notifications, SETTINGS_DEFAULTS.notifications);
    assert.equal(s.pipeline.concurrentCap, 8);
  });
});

describe('loadSettings — notifications merge + coerce', () => {
  test('partial notifications block merges onto defaults', () => {
    write({ notifications: { channels: { pushover: { enabled: true } } } });
    const s = loadSettings(dir);
    assert.equal(s.notifications.channels.pushover.enabled, true);
    // unspecified slack flag retains its default
    assert.equal(s.notifications.channels.slack, true);
  });

  test('an invalid category policy is coerced back to the default', () => {
    write({ notifications: { categories: { failure: 'sometimes' } } });
    const s = loadSettings(dir);
    assert.equal(s.notifications.categories.failure, 'workflow');
  });

  test('a valid category policy override is honored', () => {
    write({ notifications: { categories: { status: 'always' } } });
    const s = loadSettings(dir);
    assert.equal(s.notifications.categories.status, 'always');
  });

  test('a non-boolean channel flag is coerced to the default', () => {
    write({ notifications: { channels: { slack: 'yes' } } });
    const s = loadSettings(dir);
    assert.equal(s.notifications.channels.slack, true);
  });

  test('schedule windows merge per-day; timezone is preserved', () => {
    write({
      notifications: {
        workflow: { schedule: { mon: { start: '09:00', end: '17:00' }, timezone: 'America/New_York' } },
      },
    });
    const s = loadSettings(dir);
    assert.deepEqual(s.notifications.workflow.schedule.mon, { start: '09:00', end: '17:00' });
    assert.equal(s.notifications.workflow.schedule.timezone, 'America/New_York');
    // untouched days keep the empty default
    assert.deepEqual(s.notifications.workflow.schedule.tue, { start: '', end: '' });
  });

  test('manual override active + expiresAt round-trips', () => {
    write({
      notifications: { workflow: { manualOverride: { active: true, expiresAt: '2026-06-08T23:00:00Z' } } },
    });
    const s = loadSettings(dir);
    assert.equal(s.notifications.workflow.manualOverride.active, true);
    assert.equal(s.notifications.workflow.manualOverride.expiresAt, '2026-06-08T23:00:00Z');
  });

  test('a non-string expiresAt is coerced to the default (null)', () => {
    write({ notifications: { workflow: { manualOverride: { active: true, expiresAt: 12345 } } } });
    const s = loadSettings(dir);
    assert.equal(s.notifications.workflow.manualOverride.expiresAt, null);
  });

  test('malformed settings.json (bad JSON) falls back to all defaults', () => {
    writeFileSync(resolve(dir, 'settings.json'), 'not json {{{');
    const s = loadSettings(dir);
    assert.deepEqual(s.notifications, SETTINGS_DEFAULTS.notifications);
  });
});

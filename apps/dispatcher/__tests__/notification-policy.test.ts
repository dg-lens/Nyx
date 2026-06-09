import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { CATEGORY_PRIORITY, isWorkflowActive, shouldDeliver } from '../src/notification-policy.js';
import { SETTINGS_DEFAULTS, type CategoryPolicy, type NyxSettings } from '../src/settings.js';

function clone(s: NyxSettings): NyxSettings {
  return JSON.parse(JSON.stringify(s)) as NyxSettings;
}

/**
 * Build a settings object with a single weekday window so the schedule logic is
 * exercised deterministically. The window is in `tz`; tests pass a `now` whose
 * local time lands inside or outside it.
 */
function withSchedule(opts: {
  tz?: string;
  windows?: Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { start: string; end: string }>>;
  override?: { active: boolean; expiresAt: string | null };
  categories?: Partial<Record<keyof NyxSettings['notifications']['categories'], CategoryPolicy>>;
  channels?: { slack?: boolean; pushover?: boolean };
}): NyxSettings {
  const s = clone(SETTINGS_DEFAULTS);
  const sched = s.notifications.workflow.schedule;
  sched.timezone = opts.tz ?? 'UTC';
  for (const [day, win] of Object.entries(opts.windows ?? {})) {
    (sched as Record<string, { start: string; end: string }>)[day] = win!;
  }
  if (opts.override) s.notifications.workflow.manualOverride = opts.override;
  if (opts.categories) Object.assign(s.notifications.categories, opts.categories);
  if (opts.channels) {
    if (opts.channels.slack !== undefined) s.notifications.channels.slack = opts.channels.slack;
    if (opts.channels.pushover !== undefined) s.notifications.channels.pushover.enabled = opts.channels.pushover;
  }
  return s;
}

// ─── CATEGORY_PRIORITY map ─────────────────────────────────────────────────────

describe('CATEGORY_PRIORITY — Pushover priority per category', () => {
  test('maps action-required=1, failure=0, delivery=-1, status=0', () => {
    assert.equal(CATEGORY_PRIORITY['action-required'], 1);
    assert.equal(CATEGORY_PRIORITY.failure, 0);
    assert.equal(CATEGORY_PRIORITY.delivery, -1);
    assert.equal(CATEGORY_PRIORITY.status, 0);
  });

  test('covers exactly the four categories', () => {
    assert.deepEqual(Object.keys(CATEGORY_PRIORITY).sort(), [
      'action-required',
      'delivery',
      'failure',
      'status',
    ]);
  });
});

// ─── isWorkflowActive ──────────────────────────────────────────────────────────

describe('isWorkflowActive — schedule window', () => {
  // 2026-06-08 is a Monday. 14:00 UTC is inside a 09:00–17:00 Mon window.
  const monAt = (hhmm: string) => new Date(`2026-06-08T${hhmm}:00Z`);

  test('active inside the scheduled window', () => {
    const s = withSchedule({ windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, monAt('14:00')), true);
  });

  test('inactive before the window opens', () => {
    const s = withSchedule({ windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, monAt('08:59')), false);
  });

  test('inactive at/after the window closes (end is exclusive)', () => {
    const s = withSchedule({ windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, monAt('17:00')), false);
    assert.equal(isWorkflowActive(s, monAt('17:01')), false);
  });

  test('active at the exact window start (start is inclusive)', () => {
    const s = withSchedule({ windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, monAt('09:00')), true);
  });

  test('a day with no window is never in-schedule', () => {
    // Tuesday 2026-06-09 with no tue window.
    const s = withSchedule({ windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, new Date('2026-06-09T14:00:00Z')), false);
  });

  test('default settings (empty schedule, no override) → never active', () => {
    const s = clone(SETTINGS_DEFAULTS);
    assert.equal(isWorkflowActive(s, monAt('14:00')), false);
  });

  test('window honors the configured timezone', () => {
    // 09:00–17:00 in America/New_York. 2026-06-08T20:00Z is 16:00 EDT (inside);
    // 2026-06-08T22:00Z is 18:00 EDT (outside).
    const s = withSchedule({ tz: 'America/New_York', windows: { mon: { start: '09:00', end: '17:00' } } });
    assert.equal(isWorkflowActive(s, new Date('2026-06-08T20:00:00Z')), true);
    assert.equal(isWorkflowActive(s, new Date('2026-06-08T22:00:00Z')), false);
  });

  test('an end <= start window is treated as no window', () => {
    const s = withSchedule({ windows: { mon: { start: '17:00', end: '09:00' } } });
    assert.equal(isWorkflowActive(s, monAt('18:00')), false);
  });
});

describe('isWorkflowActive — manual override', () => {
  const offHours = new Date('2026-06-08T03:00:00Z'); // 03:00 Mon, outside a 09–17 window

  test('override with no expiry forces active outside the schedule', () => {
    const s = withSchedule({
      windows: { mon: { start: '09:00', end: '17:00' } },
      override: { active: true, expiresAt: null },
    });
    assert.equal(isWorkflowActive(s, offHours), true);
  });

  test('override active and not yet expired → active', () => {
    const s = withSchedule({
      override: { active: true, expiresAt: '2026-06-08T04:00:00Z' },
    });
    assert.equal(isWorkflowActive(s, offHours), true);
  });

  test('override active but expired → inactive', () => {
    const s = withSchedule({
      override: { active: true, expiresAt: '2026-06-08T02:00:00Z' },
    });
    assert.equal(isWorkflowActive(s, offHours), false);
  });

  test('override inactive flag → inactive even with a future expiry', () => {
    const s = withSchedule({
      override: { active: false, expiresAt: '2026-06-08T23:00:00Z' },
    });
    assert.equal(isWorkflowActive(s, offHours), false);
  });

  test('override with a malformed expiresAt → inactive (fail closed)', () => {
    const s = withSchedule({ override: { active: true, expiresAt: 'not-a-date' } });
    assert.equal(isWorkflowActive(s, offHours), false);
  });
});

// ─── shouldDeliver ─────────────────────────────────────────────────────────────

describe('shouldDeliver — per-category policy gating', () => {
  const inWindow = new Date('2026-06-08T14:00:00Z'); // Mon 14:00, inside 09–17
  const offHours = new Date('2026-06-08T03:00:00Z'); // Mon 03:00, outside

  const baseWindows = { mon: { start: '09:00', end: '17:00' } } as const;

  test('always → delivers regardless of schedule', () => {
    const s = withSchedule({ windows: baseWindows, categories: { status: 'always' } });
    assert.equal(shouldDeliver('status', s, offHours).deliver, true);
    assert.equal(shouldDeliver('status', s, inWindow).deliver, true);
  });

  test('workflow → delivers in-schedule, suppresses off-hours', () => {
    const s = withSchedule({ windows: baseWindows, categories: { failure: 'workflow' } });
    assert.equal(shouldDeliver('failure', s, inWindow).deliver, true);
    assert.equal(shouldDeliver('failure', s, offHours).deliver, false);
  });

  test('workflow → delivers off-hours when an override is live', () => {
    const s = withSchedule({
      windows: baseWindows,
      categories: { failure: 'workflow' },
      override: { active: true, expiresAt: null },
    });
    assert.equal(shouldDeliver('failure', s, offHours).deliver, true);
  });

  test('workhours → delivers in-schedule but ignores a live override', () => {
    const s = withSchedule({
      windows: baseWindows,
      categories: { 'action-required': 'workhours' },
      override: { active: true, expiresAt: null },
    });
    assert.equal(shouldDeliver('action-required', s, inWindow).deliver, true);
    assert.equal(shouldDeliver('action-required', s, offHours).deliver, false);
  });

  test('digest → never delivers live', () => {
    const s = withSchedule({ windows: baseWindows, categories: { status: 'digest' } });
    assert.equal(shouldDeliver('status', s, inWindow).deliver, false);
    assert.equal(shouldDeliver('status', s, offHours).deliver, false);
  });

  test('off → never delivers', () => {
    const s = withSchedule({ windows: baseWindows, categories: { delivery: 'off' } });
    assert.equal(shouldDeliver('delivery', s, inWindow).deliver, false);
  });
});

describe('shouldDeliver — channel reflection', () => {
  test('channels mirror the settings flags', () => {
    const s = withSchedule({ channels: { slack: true, pushover: true }, categories: { status: 'always' } });
    assert.deepEqual(shouldDeliver('status', s, new Date()).channels, { slack: true, pushover: true });
  });

  test('disabled channels report false', () => {
    const s = withSchedule({ channels: { slack: false, pushover: false }, categories: { status: 'always' } });
    assert.deepEqual(shouldDeliver('status', s, new Date()).channels, { slack: false, pushover: false });
  });

  test('channels are reported even when deliver is false', () => {
    const s = withSchedule({ channels: { slack: true, pushover: false }, categories: { status: 'off' } });
    const decision = shouldDeliver('status', s, new Date());
    assert.equal(decision.deliver, false);
    assert.deepEqual(decision.channels, { slack: true, pushover: false });
  });
});

describe('default settings — backward-compatible category policies', () => {
  test('SETTINGS_DEFAULTS sets action-required/failure/delivery → workflow, status → digest', () => {
    const c = SETTINGS_DEFAULTS.notifications.categories;
    assert.equal(c['action-required'], 'workflow');
    assert.equal(c.failure, 'workflow');
    assert.equal(c.delivery, 'workflow');
    assert.equal(c.status, 'digest');
  });

  test('SETTINGS_DEFAULTS enables Slack, disables Pushover', () => {
    assert.equal(SETTINGS_DEFAULTS.notifications.channels.slack, true);
    assert.equal(SETTINGS_DEFAULTS.notifications.channels.pushover.enabled, false);
  });
});

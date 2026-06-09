/**
 * Pure server-side notification policy — the part of Track 6 that Pushover's
 * device-side priority/quiet-hours can't express: the scheduled "Workflow"
 * window, the manual "working late" override, and the per-category send/suppress
 * decision. No side effects, no I/O — every function is a deterministic
 * `(settings, now) → decision`, so the dispatcher computes the policy once per
 * send and the tests pin behavior with a fixed `now`.
 */
import type { NotificationCategory, NyxSettings } from './settings.js';

/**
 * Category → Pushover priority. Maps the operator's intent onto Pushover's
 * native priority semantics (which own device-side DND): `1` bypasses the user's
 * quiet hours, `0` respects them, `-1` is silent/low. We deliberately do NOT use
 * `2` (emergency/ack-required) — that's a louder contract than any current event
 * warrants.
 */
export const CATEGORY_PRIORITY: Record<NotificationCategory, number> = {
  'action-required': 1,
  failure: 0,
  delivery: -1,
  status: 0,
};

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/**
 * The local weekday + minutes-since-midnight at `now` in `timeZone`, via Intl so
 * no tz database dependency is needed. An invalid timezone throws inside
 * DateTimeFormat; callers treat a throw as "no schedule resolvable" (Workflow
 * falls back to the override-only path).
 */
function localParts(now: Date, timeZone: string): { weekday: WeekdayKey; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday').toLowerCase().slice(0, 3) as WeekdayKey;
  // Intl emits "24" for midnight under hour12:false in some engines; normalize.
  const hh = Number.parseInt(get('hour'), 10) % 24;
  const mm = Number.parseInt(get('minute'), 10);
  return { weekday: wd, minutes: hh * 60 + mm };
}

/** Parse an "HH:MM" window bound to minutes-since-midnight, or null if empty/malformed. */
function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True if `now` falls inside today's scheduled working window for the operator's timezone. */
function isInSchedule(settings: NyxSettings, now: Date): boolean {
  const { schedule } = settings.notifications.workflow;
  let parts: { weekday: WeekdayKey; minutes: number };
  try {
    parts = localParts(now, schedule.timezone);
  } catch {
    return false;
  }
  const window = schedule[parts.weekday];
  if (!window) return false;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null) return false;
  // A window where end <= start is treated as no window (overnight windows are
  // out of scope for v1 — the desktop editor enforces start < end).
  if (end <= start) return false;
  return parts.minutes >= start && parts.minutes < end;
}

/** True if a manual "working late" override is armed AND has not yet self-expired at `now`. */
function isOverrideActive(settings: NyxSettings, now: Date): boolean {
  const { manualOverride } = settings.notifications.workflow;
  if (!manualOverride.active) return false;
  if (manualOverride.expiresAt === null) return true;
  const expiry = Date.parse(manualOverride.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return now.getTime() < expiry;
}

/**
 * Workflow is "active" when the operator is in their scheduled working window OR
 * a live manual override is in force. This is the gate the `workflow` category
 * policy keys off; `workhours` keys off the schedule alone (ignores override).
 */
export function isWorkflowActive(settings: NyxSettings, now: Date): boolean {
  return isInSchedule(settings, now) || isOverrideActive(settings, now);
}

export interface DeliverDecision {
  deliver: boolean;
  channels: { slack: boolean; pushover: boolean };
}

/**
 * Resolve whether a category should be delivered right now and on which enabled
 * channels. The per-category policy decides the time-gate; the channels block
 * decides the fan-out. `digest`/`off` never deliver live (digest items batch
 * later via the DIGEST-* family — that batching is N4, not here).
 *
 * Channel enablement is read from settings only; the notifier layer additionally
 * gates Pushover on creds being present (empty creds → Pushover disabled). Tests
 * here exercise the policy/time logic; the cred gate is tested at the sink.
 */
export function shouldDeliver(category: NotificationCategory, settings: NyxSettings, now: Date): DeliverDecision {
  const channels = {
    slack: settings.notifications.channels.slack,
    pushover: settings.notifications.channels.pushover.enabled,
  };
  const policy = settings.notifications.categories[category];

  let timeOk: boolean;
  switch (policy) {
    case 'always':
      timeOk = true;
      break;
    case 'workflow':
      timeOk = isWorkflowActive(settings, now);
      break;
    case 'workhours':
      timeOk = isInSchedule(settings, now);
      break;
    case 'digest':
    case 'off':
    default:
      timeOk = false;
      break;
  }

  return { deliver: timeOk, channels };
}

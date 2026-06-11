import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '..', '..', '..', 'scripts', 'nyx-watchdog.sh');

let dataDir: string;
let binDir: string;
let curlLog: string;

const CURL_SHIM = `#!/bin/bash
printf '%s\\n' "$*" >> "$CURL_LOG"
exit 0
`;

const CREDENTIAL_KEYS = [
  'PUSHOVER_APP_TOKEN',
  'PUSHOVER_USER_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_USER_ID',
  'SLACK_WEBHOOK_URL',
];

function runWatchdog(env: Record<string, string> = {}): void {
  // Channel-credential presence MUST be controlled by the test's `env` arg alone.
  // The dispatcher exports PUSHOVER_*/SLACK_* (it sources .env with `set -a`), so an
  // unscrubbed `...process.env` leaks the operator's real creds into the no-credentials
  // cases and breaks the gate on every code task. Strip them from the base env.
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of CREDENTIAL_KEYS) delete base[k];
  execFileSync('bash', [SCRIPT], {
    env: {
      ...base,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      NYX_DATA_DIR: dataDir,
      CURL_LOG: curlLog,
      ...env,
    },
    stdio: 'pipe',
  });
}

function curlInvocations(): string[] {
  if (!existsSync(curlLog)) return [];
  return readFileSync(curlLog, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function writeLastTickOk(epochSec: number): void {
  writeFileSync(join(dataDir, 'data', 'last-tick-ok'), String(epochSec), 'utf8');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wd-data-'));
  binDir = mkdtempSync(join(tmpdir(), 'wd-bin-'));
  mkdirSync(join(dataDir, 'data'), { recursive: true });
  curlLog = join(dataDir, 'curl.log');
  const shim = join(binDir, 'curl');
  writeFileSync(shim, CURL_SHIM, 'utf8');
  chmodSync(shim, 0o755);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('nyx-watchdog.sh — alerting behavior', () => {
  test('(a) stale heartbeat -> exactly one alert (pushover URL when PUSHOVER_* set)', () => {
    writeLastTickOk(nowSec() - 6 * 3600);
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });

    const calls = curlInvocations();
    assert.equal(calls.length, 1, 'exactly one curl invocation for a stale heartbeat');
    assert.ok(calls[0].includes('api.pushover.net'), 'pushover is the first channel');
    assert.ok(existsSync(join(dataDir, 'data', 'watchdog-last-alert')), 'dedup state file written');
  });

  test('(b) immediate second run -> NO new alert (dedup)', () => {
    writeLastTickOk(nowSec() - 6 * 3600);
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 1, 'first run alerts once');

    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 1, 'second run within the repeat window is suppressed');
  });

  test('(c) recovery run -> exactly one all-clear + state file deleted', () => {
    writeLastTickOk(nowSec() - 6 * 3600);
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    const afterAlert = curlInvocations().length;
    assert.equal(afterAlert, 1);

    writeLastTickOk(nowSec());
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });

    const calls = curlInvocations();
    assert.equal(calls.length, 2, 'exactly one additional curl (the all-clear)');
    assert.ok(calls[1].includes('api.pushover.net'), 'all-clear goes out via pushover too');
    assert.ok(
      !existsSync(join(dataDir, 'data', 'watchdog-last-alert')),
      'state file deleted after all-clear',
    );
  });

  test('(d) healthy run with no prior alert -> no curl at all', () => {
    writeLastTickOk(nowSec());
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 0, 'a healthy tick with no outstanding alert is silent');
    assert.ok(!existsSync(join(dataDir, 'data', 'watchdog-last-alert')));
  });

  test('(e) future-dated heartbeat -> no alert', () => {
    writeLastTickOk(nowSec() + 6 * 3600);
    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 0, 'clock-skew (future) is treated as healthy, not a parse error');
  });

  test('(f) update-failed.marker present -> alert with dedup', () => {
    writeLastTickOk(nowSec());
    writeFileSync(join(dataDir, 'data', 'update-failed.marker'), 'keg broke', 'utf8');

    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 1, 'marker fires an alert even though the tick is fresh');

    runWatchdog({ PUSHOVER_APP_TOKEN: 'app-tok', PUSHOVER_USER_KEY: 'user-key' });
    assert.equal(curlInvocations().length, 1, 'marker alert is deduped on the next run');
  });

  test('no-credentials stale run -> no curl (falls through to the log line)', () => {
    writeLastTickOk(nowSec() - 6 * 3600);
    runWatchdog();
    assert.equal(curlInvocations().length, 0, 'with no channels configured the alert only logs');
    assert.ok(
      existsSync(join(dataDir, 'data', 'watchdog-last-alert')),
      'dedup state is still recorded so a later run will not double-log',
    );
  });
});

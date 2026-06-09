import { spawn } from 'node:child_process';
import { registerClaude, deregisterClaude, type ClaudeMeta } from './claude-registry.js';

/**
 * Distinct exit code for a spawn killed by the stdout-silence watchdog. Kept
 * separate from the wall-clock-timeout 124 so the dispatcher can classify a hung
 * spawn ("stalled" — no output for N minutes, likely a wedged MCP/tool call) apart
 * from a spawn that was genuinely still working when its budget ran out.
 */
export const STALLED_EXIT_CODE = 125;

export interface SpawnWithTimeoutOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureStdout?: boolean;
  label?: string;
  /**
   * Loop-detector / liveness heartbeat: if set, the spawn is killed early when
   * no stdout OR stderr byte arrives for this many ms. A pid-alive check can't
   * catch a zombie blocked on a hung tool call — output silence can. Off by
   * default (existing callers are unaffected). The watchdog timer is the inner
   * heartbeat; `timeoutMs` remains the hard outer wall-clock cap.
   */
  silenceTimeoutMs?: number;
  // Class + task attribution for the claude registry. The type-aware
  // concurrency model counts GIT vs ISO spawns to keep the aggregate Max-plan
  // budget. Defaults to ISO (the safe, non-GIT-blocking) class when omitted, so
  // pre-existing callers compile unchanged.
  claudeMeta?: ClaudeMeta;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killedByTimeout: boolean;
  /** True when the silence watchdog (not the wall-clock timeout) killed the spawn. */
  stalledBySilence: boolean;
  // True when the child's output carried a rate-limit signal (429 /
  // rate_limit_error / overloaded_error). The dispatcher treats this as a
  // capacity event (cooldown + leave the task queued), NOT a code defect.
  rateLimited: boolean;
  // Parsed from a Retry-After header echoed in the child output, if present.
  retryAfterMs?: number;
}

/**
 * Scan spawned-claude output for a rate-limit / overload signal — keyed on
 * MACHINE signatures, never on free-text prose.
 *
 * The signal fires only on:
 *   - `rate_limit_error` / `overloaded_error` — the Anthropic API error-object
 *     `type` values (the `{"type":"error","error":{"type":"rate_limit_error"}}`
 *     shape the CLI surfaces when the dispatcher itself is throttled). The
 *     trailing `_error` is the discriminator: it's the API's machine token, not
 *     something a task implementing "rate limiting" would emit about its own work.
 *   - a `429` ONLY when it appears as an explicit `HTTP` status token
 *     (`HTTP 429`, `HTTP/1.1 429`). That framing is how a transport layer
 *     reports the response; it is not how task prose describes a rate-limiter
 *     ("returns 429 Too Many Requests to clients") nor how a test fixture
 *     asserts one (`status === 429`) — neither carries the `HTTP` keyword, so
 *     neither trips. The narrow `HTTP`-keyword gate (not `status`/`code`, which
 *     appear in ordinary source/tests) is deliberate.
 *
 * Deliberately does NOT match the free-text phrases `rate limit` / `rate-limit`
 * / `too many requests`, nor a bare `429` in prose or a code assertion. A code
 * task whose JOB is to implement rate limiting legitimately prints those (in its
 * VERDICT line, its diff, a test name). Matching them misclassified that task's
 * OWN output as the dispatcher being throttled — the task got abandoned,
 * re-queued, re-ran, re-tripped: a livelock. See the Arachne lesson
 * `nyx-concurrency-redesign-pitfalls`. The authoritative backstop is the
 * caller's exit-code gate (spawnWithTimeout only honors this on a non-zero exit).
 *
 * Conservative by construction: a false negative just means we don't back off
 * (the next spawn 429s again and we catch it then); a false positive stalls the
 * queue, so every path is gated on a machine token.
 */
export function detectRateLimit(output: string): { rateLimited: boolean; retryAfterMs?: number } {
  const hasMachineSignature = /rate_limit_error|overloaded_error/i.test(output);
  // 429 only as an explicit HTTP-status token (`HTTP 429`, `HTTP/1.1 429`).
  // Excludes a bare `429` in prose or a `status === 429` code assertion.
  const hasHttp429 = /\bhttp\b[^\n]{0,6}\b429\b/i.test(output);
  const rateLimited = hasMachineSignature || hasHttp429;
  if (!rateLimited) return { rateLimited: false };
  const m = output.match(/retry[- ]?after['":\s]*?(\d+(?:\.\d+)?)/i);
  if (m && m[1]) {
    const secs = Number.parseFloat(m[1]);
    if (Number.isFinite(secs) && secs > 0) return { rateLimited: true, retryAfterMs: Math.round(secs * 1000) };
  }
  return { rateLimited: true };
}

/**
 * Sends signal to the process group rooted at pid (process.kill(-pid, signal)).
 * Swallows ESRCH if the group is already gone.
 */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Spawns a command with a hard timeout that kills the entire process group.
 *
 * Root cause this fixes: `claude` spawns tool-invocation grandchildren that
 * inherit stdio pipe FDs. Sending SIGTERM to the direct child exits claude but
 * leaves grandchildren alive; they keep the pipe open so the ChildProcess
 * 'close' event never fires and the caller hangs indefinitely — causing
 * durations to overshoot the budget by up to 6x.
 *
 * Fix: `detached: true` makes claude a process-group leader. On timeout,
 * `process.kill(-pid, signal)` signals the entire group (claude + all
 * descendants), closing all pipe FDs so 'close' fires promptly.
 *
 * The nested SIGKILL timer reference is stored so it can be cancelled when
 * 'close' fires before the 5-second grace window expires, preventing a leak.
 */
export function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnWithTimeoutOptions,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    // stdout is piped whenever it's captured OR a silence watchdog is armed (the
    // watchdog needs to observe stdout bytes as liveness). Otherwise 'ignore', so
    // the no-watchdog/no-capture path keeps its original FD shape exactly.
    const pipeStdout = options.captureStdout || options.silenceTimeoutMs !== undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', pipeStdout ? 'pipe' : 'ignore', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) registerClaude(child.pid, options.claudeMeta ?? { class: 'iso' });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let stalledBySilence = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const label = options.label ?? 'nyx';

    // Escalate a kill from SIGTERM → SIGKILL after a 5s grace window. Shared by
    // both the wall-clock timeout and the silence watchdog.
    const escalateKill = (): void => {
      if (child.pid !== undefined) {
        killTree(child.pid, 'SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (child.pid !== undefined) killTree(child.pid, 'SIGKILL');
          sigkillTimer = null;
        }, 5000);
      }
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      escalateKill();
    }, timeoutMs);

    // Loop-detector heartbeat: reset on every output chunk; firing means the spawn
    // produced no output for the whole window — treat as a hung tool/MCP call and
    // kill early with a 'stalled' classification (distinct from wall-clock 124).
    const armSilence = (): void => {
      if (!options.silenceTimeoutMs) return;
      silenceTimer = setTimeout(() => {
        stalledBySilence = true;
        escalateKill();
      }, options.silenceTimeoutMs);
    };
    const resetSilence = (): void => {
      if (!options.silenceTimeoutMs || killedByTimeout || stalledBySilence) return;
      if (silenceTimer !== null) clearTimeout(silenceTimer);
      armSilence();
    };
    armSilence();

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (sigkillTimer !== null) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      if (silenceTimer !== null) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    };

    if (options.captureStdout) {
      child.stdout?.on('data', (b: Buffer) => {
        stdout += b.toString();
        resetSilence();
      });
    } else {
      // Even when stdout isn't captured, its bytes still count as liveness for the
      // watchdog — otherwise a non-capturing spawn that only writes stdout looks
      // silent and gets falsely killed. Drain without buffering.
      child.stdout?.on('data', () => {
        resetSilence();
      });
    }
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
      resetSilence();
    });

    child.on('close', (code) => {
      clearTimers();
      if (child.pid !== undefined) deregisterClaude(child.pid);
      const note = killedByTimeout
        ? `\n[${label}] timed out after ${timeoutMs}ms`
        : stalledBySilence
          ? `\n[${label}] stalled — no output for ${options.silenceTimeoutMs}ms`
          : '';
      // The silence watchdog (STALLED_EXIT_CODE) and the wall-clock timeout (124)
      // each carry a distinct non-zero code; otherwise propagate the child's own.
      const exitCode = stalledBySilence ? STALLED_EXIT_CODE : killedByTimeout ? 124 : code ?? 1;
      // Scan both streams (stderr is always piped; stdout only when captured) so
      // a rate-limit/overload signal is caught regardless of which stream the
      // CLI surfaced it on. BUT only honor the signal on a NON-ZERO exit: a real
      // API 429/overload aborts the CLI (it exits non-zero), whereas a task that
      // exits 0 has finished its work — even if its output quotes the API error
      // tokens (a task that implements/ tests rate limiting). Honoring it on a
      // clean exit is the livelock: the completed task is re-queued forever. See
      // `nyx-concurrency-redesign-pitfalls` (Arachne).
      const rl = exitCode !== 0 ? detectRateLimit(`${stderr}\n${stdout}`) : { rateLimited: false };
      resolve({
        exitCode,
        stdout,
        stderr: `${stderr}${note}`,
        durationMs: Date.now() - start,
        killedByTimeout,
        stalledBySilence,
        rateLimited: rl.rateLimited,
        ...(rl.retryAfterMs != null ? { retryAfterMs: rl.retryAfterMs } : {}),
      });
    });

    child.on('error', (err) => {
      clearTimers();
      if (child.pid !== undefined) deregisterClaude(child.pid);
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n[${label}] spawn error: ${(err as Error).message}`,
        durationMs: Date.now() - start,
        killedByTimeout: false,
        stalledBySilence: false,
        rateLimited: false,
      });
    });
  });
}

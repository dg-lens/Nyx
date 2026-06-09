import { spawn } from 'node:child_process';
import { registerClaude, deregisterClaude } from './claude-registry.js';

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
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killedByTimeout: boolean;
  /** True when the silence watchdog (not the wall-clock timeout) killed the spawn. */
  stalledBySilence: boolean;
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
    if (child.pid !== undefined) registerClaude(child.pid);

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
      resolve({
        exitCode: stalledBySilence ? STALLED_EXIT_CODE : killedByTimeout ? 124 : code ?? 1,
        stdout,
        stderr: `${stderr}${note}`,
        durationMs: Date.now() - start,
        killedByTimeout,
        stalledBySilence,
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
      });
    });
  });
}

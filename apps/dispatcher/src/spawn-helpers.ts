import { spawn } from 'node:child_process';
import { registerClaude, deregisterClaude } from './claude-registry.js';

export interface SpawnWithTimeoutOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureStdout?: boolean;
  label?: string;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killedByTimeout: boolean;
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) registerClaude(child.pid);

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const label = options.label ?? 'nyx';

    const timer = setTimeout(() => {
      killedByTimeout = true;
      if (child.pid !== undefined) {
        killTree(child.pid, 'SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (child.pid !== undefined) killTree(child.pid, 'SIGKILL');
          sigkillTimer = null;
        }, 5000);
      }
    }, timeoutMs);

    if (options.captureStdout) {
      child.stdout?.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
    }
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined) deregisterClaude(child.pid);
      if (sigkillTimer !== null) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      resolve({
        exitCode: killedByTimeout ? 124 : code ?? 1,
        stdout,
        stderr: killedByTimeout
          ? `${stderr}\n[${label}] timed out after ${timeoutMs}ms`
          : stderr,
        durationMs: Date.now() - start,
        killedByTimeout,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (child.pid !== undefined) deregisterClaude(child.pid);
      if (sigkillTimer !== null) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n[${label}] spawn error: ${(err as Error).message}`,
        durationMs: Date.now() - start,
        killedByTimeout: false,
      });
    });
  });
}

/**
 * Off-hours digest rising-edge flush (Track 6, N4).
 *
 * Extracted from the dispatcher tick (`cli/run-once.ts`) so the edge state
 * machine is unit-testable without importing the tick entrypoint (which runs
 * `main()` on import). Pure orchestration over three collaborators:
 *   - `isWorkflowActive(settings, now)` — the time-gate.
 *   - the durable digest store (`readDigestState`/`writeDigestState`/
 *     `pendingDigestCount`) — survives the per-tick launchd process.
 *   - `flushDigest()` — renders + sends the "what you missed" summary.
 *
 * Each tick records whether Workflow is active now; the inactive→active rising
 * edge IS the "next working-window start" trigger. That edge covers both a
 * scheduled window opening and a manual "working late" override being armed, so
 * no separate override-activation hook is needed — arming the override on any
 * surface flips `isWorkflowActive`, and the next tick (≤5 min later) sees the
 * edge and flushes. A flush only runs on the edge, so a long working window
 * doesn't re-flush every 5 minutes; items that arrive WHILE active are sent live
 * by `deliver` and never reach the batch.
 */
import { config } from './config.js';
import { isWorkflowActive } from './notification-policy.js';
import { pendingDigestCount, readDigestState, writeDigestState } from './notification-digest.js';
import { flushDigest } from './notifier.js';

export async function maybeFlushDigest(now: Date = new Date()): Promise<void> {
  const active = isWorkflowActive(config.settings, now);
  const state = readDigestState();
  if (active && !state.wasActive) {
    // Rising edge. Only CONSUME the edge (mark wasActive=true) once the catch-up
    // summary actually went out. `flushDigest` returns 0 both when there was
    // nothing pending AND when the send FAILED — distinguish them: a failed send
    // with items still batched must NOT consume the edge, or the batch would sit
    // until the *next* inactive→active edge (possibly a full day later) instead
    // of retrying on the very next tick. Re-check the pending count AFTER the
    // attempt: if items remain, the flush failed → leave wasActive=false so the
    // next tick (≤5 min) re-attempts; if the batch is now empty (sent, or nothing
    // to send), the edge is genuinely consumed.
    const flushed = await flushDigest();
    if (flushed > 0) console.log(`[nyx] flushed ${flushed} batched digest item(s) at working-window start`);
    if (pendingDigestCount() > 0) {
      console.log('[nyx] digest flush failed at working-window start; keeping batch + edge for retry next tick');
      return;
    }
    writeDigestState({ wasActive: true, lastFlushAt: now.toISOString() });
  } else if (active !== state.wasActive) {
    writeDigestState({ wasActive: active, lastFlushAt: state.lastFlushAt });
  }
}

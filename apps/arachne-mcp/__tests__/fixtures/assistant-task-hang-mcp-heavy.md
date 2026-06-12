---
id: assistant-task-hang-mcp-heavy
kind: lesson
title: "Assistant task hangs on MCP-heavy spec (MORNING-BRIEF class)"
summary: "When an assistant task exits 124 with empty stdout-tail after writing its artifact — serial MCP latency or an unauthenticated MCP re-auth loop stalled the agent."
loc: [stack.nyx.dispatch]
concern: [spawn, state-machine]
load: match
audience: [coder, reviewer]
weight: 6
triggers: ["claude exit 124", "timed out after 1800000ms", "assistant task hang", "MORNING-BRIEF", "CHECKLIST-SYNC", "MCP re-auth loop", "ASSISTANT COMPLETE sentinel"]
edges:
  relates: [analysis-task-hang-after-artifact, code-task-hang-after-artifact, spawner-kill-timeout]
provenance: operator
confidence: high
status: active
created: 2026-05-28
updated: 2026-05-28
pattern_signature: "claude exit 124"
---

# Assistant task hangs on MCP-heavy spec (MORNING-BRIEF class)

SYMPTOM:
Nyx `assistant`-type task exits 124 with stderr `[nyx] timed out after 1800000ms` and an EMPTY `stdout-tail`. Preserved working dir for MORNING-BRIEF (2026-05-28) contained an `ASSISTANT_OUTPUT.md` dated 2026-05-22 — i.e. the daily slot had been failing this way for several consecutive days, with the May 22 artifact left over from whichever last attempt managed to write before hanging. Also observed in CHECKLIST-SYNC (2026-05-28T13:37Z): `ASSISTANT_OUTPUT.md` was current (mtime today UTC), comprehensive across Gmail/Notion/Slack/Calendar — agent finished the brief, then hung on a follow-up MCP call (Calendar marked "MCP not available" — likely re-auth loop). Same root shape as the analysis and code hang-after-artifact lessons (agent does work, then sits idle until SIGTERM), but the trigger here is MCP-call latency aggregation rather than a "deliverable already produced" drift state.

CAUSE:
MORNING-BRIEF's spec asks the spawned Haiku agent to make ~6 MCP calls (Gmail search, Calendar list, Slack DM reads, Notion fetch, Notion search, Supabase query, optionally Google Drive) in sequence, then write a markdown summary, then DM the operator on Slack. Two failure modes compound:
1. **MCP-call serial latency on Haiku.** Each Gmail/Slack/Notion call regularly takes 5–15 seconds. The agent does not parallelize. Six serial calls ≈ 60–90 s alone — fine inside the 30-min budget, but adds enough wall time that any one stalling pushes the whole task over.
2. **Unauthenticated MCP loops.** Google Calendar MCP requires explicit re-auth via `mcp__claude_ai_Google_Calendar__authenticate`. The agent, when calling Calendar tools, can sit in a re-auth waiting loop with no termination signal. Combined with no "task complete" sentinel in the spec, the agent never exits.
The May 22 `ASSISTANT_OUTPUT.md` persisting across multiple days indicates the dispatcher's working-dir wipe runs at preflight (clearing for the next attempt) but every attempt that week hit the timeout, leaving directory state as "post-write but never-finalized."

ANTI:
- **Re-running the full brief from scratch in audit-pass.** Wastes Opus budget and would itself risk hanging on the same MCPs. Correct audit-pass behavior is to write the brief directly with the tools the audit-pass session already has, not to re-spawn the original agent style.
- **Treating exit 124 as proof the brief content is corrupt.** With assistant tasks the artifact on disk may be N days old (stale) — but the failure mode is the timeout, not corruption. Check the file's mtime against today's date before deciding whether to reuse it.
- **Adding a "skip Calendar if unauthenticated" branch to the agent prompt at audit-pass time.** Wrong scope for an audit-pass fix; that belongs in the original task spec.

FIX:
Two-layer fix.
**1. Audit-pass shortcut (operational):** when the failed task is `type: assistant` AND the working dir's `ASSISTANT_OUTPUT.md` has an mtime older than today (UTC), treat the existing file as stale and produce a fresh brief directly within the audit-pass session using whatever MCP tools the Opus session has loaded. Skip MCPs that require auth the audit session can't complete (Calendar). Archive a dated copy under `~/Nyx/outputs/morning-brief/archive/YYYY-MM-DD.md` so tomorrow's brief can diff against it. DM the operator. Exit `VERDICT: fixed`. If the artifact's mtime is from today (UTC), the brief is current — skip re-running; DM the operator directly from the audit-pass session.
**2. Dispatcher / spec hardening (queued):**
- Add a closing-line convention to assistant task prompt templates: when the deliverable file is written AND any required follow-up tool call (e.g. Slack DM) has returned, the agent's final stdout line MUST be `ASSISTANT COMPLETE`. After emitting that line, do not call any further tools. Combined with a dispatcher-side stdout regex short-circuit, this surfaces artifact-complete-but-hung as a clean success.
- For MORNING-BRIEF specifically: rewrite the spec to (a) explicitly skip Calendar if `authenticate` is required, (b) batch MCP calls in parallel where possible, (c) add the closing sentinel.
- Wire a Supabase MCP — the spec asks for a `waitlist_users` count, but no Supabase MCP is registered in `~/.claude.json`. Either add the MCP or rewrite the spec to use `curl` against `${SUPABASE_URL}/rest/v1/waitlist_users?select=count` with the service key.

CHECK:
On exit 124 for an assistant task: inspect the preserved working dir's `ASSISTANT_OUTPUT.md` mtime BEFORE deciding to re-run. Today (UTC) → reuse and DM. Stale → regenerate in audit-pass, skipping auth-requiring MCPs. Confirm the prompt template carries the `ASSISTANT COMPLETE` sentinel.

<!-- links:auto -->
_links:_ [[analysis-task-hang-after-artifact]] [[code-task-hang-after-artifact]] [[spawner-kill-timeout]]
<!-- /links:auto -->

# Installing Nyx (co-located box) — operator guide

For running Nyx's pipeline on a machine that's **already running other `claude -p`
workloads** (e.g. a pm2 swarm). Nyx and the existing workers ignore each other.

**The flow:** a one-time terminal install, then everything else — config, queueing
work, approving gates, watching runs — happens in the **Nyx desktop app**. You should
not need the command line after step 3 (a CLI equivalent is in the appendix for
headless/SSH use).

---

## 0. Prerequisites
- **macOS** with [Homebrew](https://brew.sh).
- **Repo access** — your GitHub account must be a collaborator on the private
  `dg-lens/Nyx` repo (read), **and** have write access to whatever repos your pipeline
  will build in (it pushes branches + opens PRs there). Ask the operator to grant both.
- **Claude on this box** — Claude Code logged in with a **Max plan** (recommended;
  the spawned `claude -p` inherits the OAuth), or an Anthropic **API key**.
- **Xcode Command Line Tools** — needed once to build the desktop app:
  `xcode-select --install`.
- **git** + **gh** authenticated. `node` + `pnpm` are installed by the formula.

---

## 1. Install (terminal — one time)
The repo is **private**, so authenticate first; Homebrew's git clone then uses your
GitHub credentials:
```bash
gh auth login            # sign in to the GitHub account that has repo access
gh auth setup-git        # let git + Homebrew use that auth
brew tap dg-lens/nyx https://github.com/dg-lens/Nyx
brew install --HEAD dg-lens/nyx/nyx
nyx bootstrap            # creates ~/Nyx/Data + ~/Nyx/Plugins AND builds the desktop app
```
(The `curl … raw.githubusercontent … | bash` one-liner only works once the repo is
**public** — on a private repo use the steps above.)

`nyx bootstrap` builds the SwiftUI app into **`/Applications/Nyx.app`** as its last step
(needs Xcode CLT — `xcode-select --install`; on a headless box it skips this with a note).
Open it — everything from here on is in the app. To rebuild it later, `nyx app`.

---

## 2. First-run setup — all in the **Settings** tab
Open the **Settings** tab. Work top to bottom; each section has a Save button.

- **Identity** — set your **Operator name** → *Save identity*.
- **Environment & Secrets** — manage every variable here (no need to touch any file):
  - `ANTHROPIC_API_KEY` — **leave blank** to use this box's Claude Max OAuth. Only set
    it if you want API-key billing instead.
  - `GITHUB_TOKEN` — optional if `gh auth login` is done; otherwise paste a PAT.
  - Slack vars can stay blank. → *Save environment*.
- **Dispatcher → Concurrency guard** — set to **“Own — skip only for Nyx's own claude
  (co-located box)”**. This is the key setting for a shared box: Nyx then tracks only its
  *own* spawned `claude` processes and ignores your pm2 swarm, so it never skips a tick.
- **Pipeline** — set **concurrent cap** (start at 4; size it against your shared
  Anthropic rate limit). Turn **Slack notifications** off unless you've wired Slack.
  Leave **Auto-merge** off (review + merge stays yours).

## 3. Start the daemon
**Settings → Daemon → Start.** Status flips to “Running (5-min ticks)” and the health
dot in the toolbar goes green; the toolbar shows a live **next-tick** countdown. The
daemon restarts on reboot.

## 4. Queue a pipeline run — **Dispatch** tab
1. Type the feature idea in the text box.
2. **Type** → `pipeline`.
3. **Repo** → `org/name` for an existing GitHub repo (clone + PR at the end). Leave
   blank to plan against the Nyx install itself; use `local` to build a brand-new
   project under `~/Nyx/Data/projects/`.
4. Click **Decompose & Queue**.

The next tick (≤5 min) starts planning, or hit the toolbar **Tick** button to start now.

## 5. Approve at the gates — **Gates** tab
A run pauses here when it needs you. The tab shows a plain go/no-go recommendation plus
any Yes/No decisions.

- **Preview gate (◧)** — answer the Yes/No decisions, then **Go** to start coding.
  **Revise** (with a note) re-plans; **Abort** stops the run.
- **Review gate (◨)** — only appears if something couldn't be auto-reconciled.
  **Accept & continue** merges what's held and continues; **Proceed (ship merged)**
  ships what already merged; **Fix** (with a note) does a corrective re-run;
  **Rollback** / **Abort** as needed.

A clean run stops **once** (preview), then delivers a PR (for `org/name`) or a local
project. It **never auto-merges** — review + merge is yours, and deploy is a manual step.

## 6. Watch a run
- **Monitor** tab — live run + queue status.
- **Settings → Daemon → Open logs** — the raw tick logs if you want detail.

---

## 7. Update later
```bash
nyx update            # self-drives the Homebrew reinstall; logs to ~/Nyx/Data/logs/update.log
nyx update --app      # also rebuild the desktop app
```
Your `~/Nyx/Data` (config, queue, db, logs) and `~/Nyx/Plugins` are untouched — only
Core code is replaced. The daemon picks up the new code on its next tick automatically.

---

## Appendix — CLI equivalents (headless / SSH only)
Everything above maps to commands, for boxes where you can't run the GUI:
```bash
# config: edit ~/Nyx/Data/settings.json  →  {"dispatcher":{"concurrencyGuard":"own"},
#                                             "pipeline":{"concurrentCap":4,"slackNotifications":false}}
# auth/identity: edit ~/Nyx/Data/.env  (NAME, OPERATOR_NAME, GIT_AUTHOR_*, ANTHROPIC_API_KEY, GITHUB_TOKEN)
brew services start dg-lens/nyx/nyx        # start daemon  (= Settings → Daemon → Start)
nyx status                                 # health
# queue: add to ~/Nyx/Data/nyx.md under "## Active Tasks":
#   - [ ] MY-FEATURE-1 — Build <one-line>
#         [type: pipeline]
#         [repo: org/name]
nyx tick                                   # force a tick now  (= toolbar Tick)
nyx pipeline list
nyx pipeline status  <RUN-ID>
nyx pipeline go      <RUN-ID>              # preview: approve
nyx pipeline revise  <RUN-ID> --note "…"   # preview: re-plan
nyx pipeline accept  <RUN-ID>              # review: merge held + continue
nyx pipeline proceed <RUN-ID>             # review: ship merged
nyx pipeline fix     <RUN-ID> --note "…"   # review: corrective re-run
nyx pipeline abort   <RUN-ID>
tail -f ~/Nyx/Data/logs/dispatch-*.log
```

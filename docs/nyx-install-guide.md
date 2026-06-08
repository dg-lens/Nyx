# Installing Nyx (co-located box) — operator guide

For running Nyx's pipeline on a machine that's **already running other `claude -p`
workloads** (e.g. a pm2 swarm). Nyx and the existing workers ignore each other.

## 0. Prerequisites
- **macOS** with [Homebrew](https://brew.sh).
- **Repo access** — you must be a collaborator on `dg-lens/Nyx` (it's private). Run
  `gh auth login` (GitHub CLI) or have git credentials so Homebrew can clone it.
- **Claude on this box** — either Claude Code logged in with a **Max plan**
  (recommended; spawned `claude -p` inherits the OAuth), or an Anthropic **API key**.
- **git** + **gh** authenticated (the pipeline pushes branches + opens PRs).
- `node` + `pnpm` are installed automatically by the formula.

## 1. Install
```bash
curl -fsSL https://raw.githubusercontent.com/dg-lens/Nyx/main/scripts/install.sh | bash
```
This taps the repo, `brew install --HEAD` (clones + builds Core into the Homebrew
keg), and runs `nyx bootstrap` — which creates the sibling data layout:
```
~/Nyx/Data      nyx.md, settings.json, .env, data/ (SQLite), logs/, projects/, memory/
~/Nyx/Plugins   your custom plugins (optional; stock plugins ship inside Core)
```
(Core itself lives in the keg, not under ~/Nyx — that's intentional; updates replace it.)

## 2. Configure auth + identity — `~/Nyx/Data/.env`
Edit the generated `~/Nyx/Data/.env`:
```bash
NAME=nyx                              # display name of this instance (rename if you like)
OPERATOR_NAME=James
GIT_AUTHOR_NAME=James Yourlastname    # your real, GitHub-linked name
GIT_AUTHOR_EMAIL=james@yourdomain     # the email on your GitHub account
ANTHROPIC_API_KEY=                    # LEAVE EMPTY to use this box's Claude Max OAuth.
                                      # Only set it if you want API-key billing instead.
GITHUB_TOKEN=                         # optional if `gh auth login` is done; else a PAT
```
Slack and Bitwarden vars can stay empty — Nyx runs fine without them.

## 3. Configure the co-located guard — `~/Nyx/Data/settings.json`
Create `~/Nyx/Data/settings.json` with:
```json
{
  "dispatcher": {
    "concurrencyGuard": "own"
  },
  "pipeline": {
    "concurrentCap": 4,
    "slackNotifications": false
  }
}
```
- **`concurrencyGuard: "own"`** is the important one — Nyx then tracks only *its own*
  spawned `claude` processes and ignores your existing swarm, so it doesn't skip ticks.
- **`concurrentCap`** = how many pipeline coders Nyx runs at once. Size it against your
  shared Anthropic rate-limit budget (start at 4; lower if you hit limits, raise if you have headroom).
- Anything you omit falls back to safe defaults.

## 4. Start + verify
```bash
brew services start dg-lens/nyx/nyx     # launchd: a 5-minute tick, restarts on reboot
nyx status                              # daemon state, audit-chain health, queue
```
`nyx status` should show the dispatcher loaded and the queue empty.

## 5. Run a pipeline task
Add a task to `~/Nyx/Data/nyx.md` under `## Active Tasks`:
```
- [ ] MY-FEATURE-1 — Build <one-line description of the feature>
      [type: pipeline]
      [repo: your-org/your-repo]
```
- `[repo: org/name]` targets an existing GitHub repo (clone + PR at the end).
- `[repo: local]` builds a brand-new project locally under `~/Nyx/Data/projects/<task>`.
- No `[repo:]` plans against the Nyx install itself.

The next tick (≤5 min) starts planning and pauses at the **preview gate**. Drive it:
```bash
nyx pipeline list
nyx pipeline status <RUN-ID>
nyx pipeline go     <RUN-ID>            # approve the plan, start coding
nyx pipeline revise <RUN-ID> --note "…" # re-plan with a correction
# at the review gate (only if it stops there):
nyx pipeline accept <RUN-ID>            # merge what's held + continue
nyx pipeline proceed <RUN-ID>           # ship what merged
nyx pipeline fix    <RUN-ID> --note "…" # corrective re-run
nyx pipeline abort  <RUN-ID>
```
A clean run stops once (preview), then delivers a PR (for `[repo:]`) or a local
project (for `[repo: local]`). Force a tick instead of waiting: `nyx tick`.

## 6. Operate
```bash
nyx status                                   # health
tail -f ~/Nyx/Data/logs/dispatch-*.log       # tick log
brew services stop  dg-lens/nyx/nyx          # stop the daemon
brew services start dg-lens/nyx/nyx          # start it
# update to latest:
brew uninstall nyx && brew install --HEAD dg-lens/nyx/nyx
```

## Notes
- Nyx and your existing `claude` workers share one machine + one Anthropic account —
  size `concurrentCap` so the combined concurrency stays under your rate limit.
- The pipeline opens PRs but **never auto-merges** — review + merge is yours.
- Deploy of whatever the pipeline builds is a manual step (it stops at PR-ready).

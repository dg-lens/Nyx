# Changelog Convention

> **Read this before opening a PR or shipping code changes from inside a Nyx subtask.** Every code change either appends to `~/Nyx/CHANGELOG.md` (Nyx itself) OR to the offshoot project's own `CHANGELOG.md`. Same shape, different file.

---

## The two changelogs

| File | Scope | Bumped by |
|---|---|---|
| `~/Nyx/CHANGELOG.md` | Nyx's own internals — dispatcher, sync, dashboard, scripts, gates, audit, permission model | Engineering sessions modifying `apps/*`, `scripts/*`, root docs |
| `<offshoot-repo>/CHANGELOG.md` | One per offshoot. Tracks that project's own evolution. | Nyx-spawned subtasks targeting that repo, OR humans working in the repo directly |

**Rule of thumb:** if your change is inside `~/Nyx/`, you append to Nyx's changelog. If your change is inside `/tmp/nyx-clone-<TASK-ID>/` (an offshoot working dir), you append to that repo's changelog.

These are two separate timelines. Nyx's CHANGELOG records *how Nyx got smarter*. An offshoot's CHANGELOG records *what the offshoot built*.

---

## When a CHANGELOG entry is required

| Change | Need entry? |
|---|---|
| New feature / new behavior | **Yes** |
| Bug fix that changes any externally-observable behavior | **Yes** |
| Schema migration | **Yes** |
| Breaking API change | **Yes**, mark with `**BREAKING**` |
| Internal refactor with identical behavior | Optional, but encouraged for institutional memory |
| Doc-only update | No |
| Test-only update | No |
| Formatting / lint fix | No |

If unsure: add the entry. Cheap to write, valuable when debugging a regression six months later.

---

## Format — both files use the same shape

```markdown
## 0.X.Y — Short title (YYYY-MM-DD)

**One-sentence summary of what changed and why.** Past tense, active voice.

### What changed
- Bullet of the most operator-visible thing
- Bullet of the next-most-visible thing
- (more bullets as needed)

### Why
Brief rationale. If this fixes a bug, link the audit row or the symptom that surfaced it. If this is a contract change, explain what wasn't working with the old contract.

### Touched
- `apps/foo/src/bar.ts` — what changed there
- `apps/foo/__tests__/baz.test.ts` — new test or modified test

### Caveats
Anything an operator should know that isn't obvious from the diff. Migration steps if any.

### Verification
- All tests pass
- Smoke run produced X
- (whatever you actually confirmed)

---

## (previous version above this divider)
```

Newest entry on top. Versions ascend.

---

## Versioning

Both Nyx and its offshoots use **loose semver during `0.x`**:

| Bump | When |
|---|---|
| `0.X.0` (minor) | New feature, new module, new task type, new gate ecosystem support |
| `0.X.Y` (patch) | Bug fix, doc fix, internal hardening that doesn't change contracts |
| `1.0.0` | Reserved for when the contract is officially frozen |

No need to coordinate Nyx's version with any offshoot's version. They evolve independently.

---

## How a Nyx-spawned subtask adds an entry to an offshoot

The dispatcher spawns `claude -p` against `/tmp/nyx-clone-<TASK-ID>/`. That working dir contains the offshoot repo. Before the subtask's commit lands, it should append the entry to that repo's `CHANGELOG.md`.

**Convention for Dispatch:** when you queue a task that modifies code in an offshoot, include this in the task description:

> *"As part of this change, append an entry to CHANGELOG.md in the repo root under a new `## X.Y.Z` heading with a one-sentence summary, the touched files, and any caveats. Use the latest version number + a patch bump for bug fixes / a minor bump for features."*

You don't have to write that boilerplate every time — once it's established in the offshoot's existing CHANGELOG, the next subtask will see the prior entries and follow the pattern. Just remind Claude when it's the offshoot's first entry.

**If the offshoot doesn't have a CHANGELOG.md yet**, the first task that touches it should create one. Use this minimal seed:

```markdown
# CHANGELOG

All notable changes to this project. Newest first.

---

## 0.1.0 — Initial bootstrap (YYYY-MM-DD)

**Project seeded by Nyx.** See `~/Nyx/nyx.md` task `<TASK-ID>` for context.

### What changed
- (whatever the first task did)

### Touched
- (files)
```

---

## How Nyx itself updates its own CHANGELOG

Engineering sessions modifying `~/Nyx/` should:

1. Read [`CHANGELOG.md`](../CHANGELOG.md) to see the prior entries' style.
2. Add a new entry on top, under the most recent version.
3. Cross-reference any related docs (`ARCHITECTURE.md`, `REVIEW_PRIMER.md`) if those need updating too — and update them in the same commit.
4. The CHANGELOG entry should be the FIRST file in the commit message diff.

**Do not** edit past entries. They're history. If a past entry was wrong, add a "## 0.X.Z — Correction to 0.X.Y" entry above it.

---

## How to find / interpret old entries

```bash
# read the whole Nyx history
less ~/Nyx/CHANGELOG.md

# show just the headers (version + title)
grep -E '^## ' ~/Nyx/CHANGELOG.md

# show entries from a specific version
sed -n '/^## 0.5.0/,/^## 0\./p' ~/Nyx/CHANGELOG.md | head -100

# search for a specific symbol or filename
grep -B 2 -A 8 'failureCountForTask' ~/Nyx/CHANGELOG.md
```

For an offshoot, same commands at `<repo-root>/CHANGELOG.md`.

---

## Why this matters

Nyx is multi-session, multi-month, multi-agent. A new Claude Code session opening any of these repos in six months will have NO memory of what happened. The CHANGELOG is the only document that explains *why* the code is shaped the way it is — what tradeoffs were considered, what was tried and reverted, what failure mode triggered the current design.

Skip the entry and you make the next agent re-discover everything by reading diffs. Write the entry and you save them a day.

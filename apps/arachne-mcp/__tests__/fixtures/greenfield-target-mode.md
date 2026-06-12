---
id: greenfield-target-mode
kind: invariant
title: Classify a pipeline run's repo via targetMode(), never truthiness
summary: "WHEN routing a pipeline run by repo: owner/name=external, empty=self(~/Nyx),
          local|new|greenfield|scratch=greenfield, else=invalid(fail fast). A flat truthy
          check cloned github.com/local.git."
loc: [stack.nyx.pipeline]
concern: [git]
load: match
audience: [planner, coder]
weight: 7
paths: [apps/dispatcher/src/pipeline/target.ts, apps/dispatcher/src/git-ops.ts, apps/dispatcher/src/pipeline/execute.ts]
symbols: [targetMode, createGreenfieldDir]
triggers: [greenfield, "repo: local", targetMode, clone, target mode]
edges:
  parent: moc-nyx-pipeline
  relates: [dispatcher-non-terminal-on-throw]
code_ref: target.ts@targetMode
verified_at: 2026-06-07
provenance: audit:2026-06-07
confidence: high
status: active
created: 2026-06-07
---

RULE: targetMode(repo) → `external` (owner/name → clone + PR), `self` (empty → ~/Nyx),
      `greenfield` (local|new|greenfield|scratch → fresh `git init` at Data/projects/<task>,
      no clone, no PR), `invalid` (anything else → fail fast with a readable message).
WHY: a two-way truthy branch treated `[repo: local]` as a GitHub repo and ran
     `git clone https://github.com/local.git` → 404 → non-terminal retry loop.
ANTI: do NOT branch on `run.repo` truthiness anywhere — route through targetMode.
      ANTI: createGreenfieldDir rm-rf's `Data/projects/<task_id>`; guard task_id collisions or
      a second greenfield run destroys the prior deliverable.
CHECK: `[repo: local]` builds into Data/projects/<task>; an invalid repo fails terminal, no loop.

<!-- links:auto -->
_links:_ [[moc-nyx-pipeline]] [[dispatcher-non-terminal-on-throw]]
<!-- /links:auto -->

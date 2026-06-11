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
triggers: [greenfield, "repo: local", targetMode, clone, target mode, pipeline target, local repo, local app, new app, app build, standalone project]
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
      no clone, no PR), `app` (app:<slug>, slug strictly [a-z0-9-]+ → greenfield variant
      landing at $NYX_APPS_DIR (default ~/Nyx/Apps)/<slug>; refusal-before-mutation if the
      dir exists, with the run's own base exempt on resume; delivery keeps the base, no PR),
      `invalid` (anything else → fail fast with a readable message).
WHY: a two-way truthy branch treated `[repo: local]` as a GitHub repo and ran
     `git clone https://github.com/local.git` → 404 → non-terminal retry loop.
ANTI: do NOT branch on `run.repo` truthiness anywhere — route through targetMode.
      ANTI: createGreenfieldDir rm-rf's `Data/projects/<task_id>`; guard task_id collisions or
      a second greenfield run destroys the prior deliverable. It refuses to rm-rf non-empty
      dirs under appsDir AND projectsDir (the durable-root backstop) — never weaken that list.
      ANTI: do not point NYX_APPS_DIR at a broad root containing the clone prefix — every
      throwaway planning dir then counts as durable and retry wipes start refusing.
CHECK: `[repo: local]` builds into Data/projects/<task>; `[repo: app:x]` lands at appsDir/x and
      a second run against the same slug fails terminal at planning; invalid repo fails, no loop.

<!-- links:auto -->
_links:_ [[moc-nyx-pipeline]] [[dispatcher-non-terminal-on-throw]]
<!-- /links:auto -->

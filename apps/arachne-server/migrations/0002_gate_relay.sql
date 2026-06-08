-- Arachne gate relay — remote pipeline-gate review across Nyx instances
-- (idempotent; re-running is a clean no-op). An origin instance (e.g. James's
-- Nyx) pushes a gate brief; an assigned reviewer instance (e.g. the operator's)
-- decides; the origin polls the decision and applies it via submitDecision.
--
-- Apply to production: paste into the Fly Postgres (or run via applyMigration).

CREATE TABLE IF NOT EXISTS gates (
  id          text PRIMARY KEY,             -- relay gate id (origin-provided, globally unique)
  origin      text NOT NULL,                -- platform id that pushed the gate
  reviewer    text NOT NULL,                -- platform id permitted to decide
  run_id      text NOT NULL,                -- pipeline run id on the origin
  task_id     text NOT NULL DEFAULT '',
  repo        text,
  gate_kind   text NOT NULL,                -- preview | review
  summary     text NOT NULL DEFAULT '',     -- go/no-go brief shown to the reviewer
  options     text[] NOT NULL DEFAULT '{}', -- allowed decision verbs for this gate
  status      text NOT NULL DEFAULT 'open', -- open | decided | consumed | aborted
  decision    text,                         -- chosen verb (once decided)
  note        text,                         -- revise/fix note
  decided_by  text,                         -- reviewer platform that decided
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_gates_reviewer ON gates (reviewer, status);
CREATE INDEX IF NOT EXISTS idx_gates_origin   ON gates (origin, status);
CREATE INDEX IF NOT EXISTS idx_gates_run      ON gates (run_id);

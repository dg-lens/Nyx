-- Arachne shared memory — Postgres schema (idempotent). The frontmatter node
-- model maps 1:1 to columns; array columns hold the multi-valued axes with GIN
-- indexes so scope/trigger/path matching is an index scan.
--
-- Apply to production: paste this whole file into the Fly Postgres (or run via
-- the apply-migrations step). Re-running is a clean no-op.

CREATE TABLE IF NOT EXISTS nodes (
  id          text PRIMARY KEY,
  kind        text        NOT NULL,
  title       text        NOT NULL,
  summary     text        NOT NULL,
  body        text        NOT NULL DEFAULT '',
  loc         text[]      NOT NULL DEFAULT '{}',
  concern     text[]      NOT NULL DEFAULT '{}',
  load_tier   text        NOT NULL DEFAULT 'match',   -- always | entry | match | manual
  audience    text[]      NOT NULL DEFAULT '{all}',
  weight      int         NOT NULL DEFAULT 4,
  paths       text[]      NOT NULL DEFAULT '{}',
  symbols     text[]      NOT NULL DEFAULT '{}',
  triggers    text[]      NOT NULL DEFAULT '{}',
  status      text        NOT NULL DEFAULT 'active',  -- active | deprecated | superseded | draft
  provenance  text        NOT NULL DEFAULT 'agent',   -- operator | agent | platform:<id> | audit:<id>
  confidence  text        NOT NULL DEFAULT 'medium',  -- high | medium | low
  review      text        NOT NULL DEFAULT 'pending', -- approved | pending
  pattern_signature text,
  code_ref    text,
  verified_at date,
  tokens      int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nodes_loc      ON nodes USING gin (loc);
CREATE INDEX IF NOT EXISTS idx_nodes_concern  ON nodes USING gin (concern);
CREATE INDEX IF NOT EXISTS idx_nodes_triggers ON nodes USING gin (triggers);
CREATE INDEX IF NOT EXISTS idx_nodes_paths    ON nodes USING gin (paths);
CREATE INDEX IF NOT EXISTS idx_nodes_status   ON nodes (status);

-- Typed edges (the graph). dst_id is not FK-constrained so a forward reference
-- or an MOC id (not a row) never blocks a write; resolution is at read time.
CREATE TABLE IF NOT EXISTS edges (
  src_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel    text NOT NULL,            -- parent | relates | supersedes | superseded_by | contradicts | depends
  dst_id text NOT NULL,
  PRIMARY KEY (src_id, rel, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst_id);

-- Per-platform auth. token_hash = sha256(bearer token); the raw token lives in
-- Bitwarden, never here.
CREATE TABLE IF NOT EXISTS platforms (
  id         text PRIMARY KEY,           -- e.g. 'nyx', 'iris', 'portal'
  name       text NOT NULL,
  token_hash text NOT NULL,
  scopes     text[] NOT NULL DEFAULT '{read,write}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outcome feedback: every assemble logs which nodes it served + (later) whether
-- the task succeeded / the node was cited. Drives weight self-tuning.
CREATE TABLE IF NOT EXISTS node_usage (
  id           bigserial PRIMARY KEY,
  node_id      text NOT NULL,
  platform     text NOT NULL,
  loaded_at    timestamptz NOT NULL DEFAULT now(),
  cited        boolean,
  task_outcome text                       -- success | fail | unknown
);
CREATE INDEX IF NOT EXISTS idx_usage_node ON node_usage (node_id);

-- Append-only audit of writes (provenance trail across platforms).
CREATE TABLE IF NOT EXISTS write_log (
  id         bigserial PRIMARY KEY,
  node_id    text NOT NULL,
  platform   text NOT NULL,
  op         text NOT NULL,              -- create | update | deprecate
  at         timestamptz NOT NULL DEFAULT now()
);

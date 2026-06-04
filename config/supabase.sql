-- ─────────────────────────────────────────────────────────────────────────────
-- Nyx — Supabase schema bootstrap
--
-- Run this once in the SQL editor of a fresh Supabase project. Idempotent —
-- safe to re-run. Mirrors the local nyx.db tables that the dashboard reads.
--
-- After running this:
--   1. Copy SUPABASE_URL and SERVICE_ROLE key into ~/Nyx/.env
--      (SUPABASE_URL=..., SUPABASE_SERVICE_KEY=...)
--   2. Copy SUPABASE_URL and ANON key into cloudflare-pages/config.js
--      (window.NYX_CONFIG = { SUPABASE_URL: ..., SUPABASE_ANON_KEY: ... })
--   3. Start the sync daemon: scripts/nyx-sync.sh start
--   4. Deploy cloudflare-pages/ to Cloudflare Pages (see DEPLOY.md).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── system_audit ─────────────────────────────────────────────────────────────
-- One-for-one mirror of local nyx.db's system_audit. Append-only. The
-- sync daemon copies rows over and never modifies past rows; the hash chain
-- on the local side is the canonical record. This mirror is for reading from
-- the dashboard.

create table if not exists system_audit (
  id         bigint primary key,           -- mirrors the local autoincrement id
  at         timestamptz not null,
  event      text not null,
  actor      text not null,
  payload    jsonb not null,
  row_hash   text not null,
  prev_hash  text not null,
  synced_at  timestamptz not null default now()
);

create index if not exists idx_system_audit_at on system_audit (at desc);
create index if not exists idx_system_audit_event on system_audit (event);
create index if not exists idx_system_audit_task on system_audit ((payload->>'taskId'));

-- ── queue_snapshot ───────────────────────────────────────────────────────────
-- The current queue parsed into JSON, written once per tick. We keep history
-- so the dashboard can show "the queue at the time of this audit event" later,
-- but for now the latest row is what the live UI reads.

create table if not exists queue_snapshot (
  id          bigserial primary key,
  taken_at    timestamptz not null default now(),
  active      jsonb not null,
  completed   jsonb not null,
  /** Convenience aggregates so the dashboard avoids re-counting on each render. */
  active_count    integer generated always as (jsonb_array_length(active)) stored,
  completed_count integer generated always as (jsonb_array_length(completed)) stored
);

create index if not exists idx_queue_snapshot_taken_at on queue_snapshot (taken_at desc);

-- ── dispatcher_status ────────────────────────────────────────────────────────
-- Single-row table holding "the current state of the dispatcher" — last tick,
-- chain ok, version, etc. Sync daemon overwrites this on every poll cycle.

create table if not exists dispatcher_status (
  id              integer primary key default 1 check (id = 1),
  updated_at      timestamptz not null default now(),
  last_tick_at    timestamptz,
  last_success_at timestamptz,
  audit_row_count integer not null default 0,
  chain_ok        boolean not null default true,
  success_rate_24h double precision,
  current_slot    integer not null default 0,
  notes           jsonb not null default '{}'::jsonb
);

-- Seed the singleton row if absent. Use upsert semantics so re-running is safe.
insert into dispatcher_status (id) values (1)
on conflict (id) do nothing;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Default deny. The anon role (used by the public dashboard) gets SELECT only.
-- The service_role key (used by the sync daemon, local-only) bypasses RLS
-- automatically, so the daemon writes work regardless of policy.

alter table system_audit       enable row level security;
alter table queue_snapshot     enable row level security;
alter table dispatcher_status  enable row level security;

-- Drop-then-create so re-running this script doesn't error on policy duplication.
drop policy if exists "anon can read system_audit"      on system_audit;
drop policy if exists "anon can read queue_snapshot"    on queue_snapshot;
drop policy if exists "anon can read dispatcher_status" on dispatcher_status;

create policy "anon can read system_audit"
  on system_audit for select
  to anon
  using (true);

create policy "anon can read queue_snapshot"
  on queue_snapshot for select
  to anon
  using (true);

create policy "anon can read dispatcher_status"
  on dispatcher_status for select
  to anon
  using (true);

-- ── Retention helpers (optional, run via Supabase scheduled functions) ──────
-- Free-tier Supabase is 500MB. ~200 bytes per audit row = ~2.5M rows before
-- pressure. queue_snapshot is heavier (full queue JSON per row), so we cap it.

create or replace function prune_old_snapshots(keep_count integer default 5000)
returns integer
language sql
security definer
as $$
  with kept as (
    select id from queue_snapshot order by taken_at desc limit keep_count
  )
  delete from queue_snapshot
  where id not in (select id from kept)
  returning 1;
$$;

create or replace function prune_old_audit_rows(older_than_days integer default 90)
returns integer
language sql
security definer
as $$
  delete from system_audit
  where at < now() - (older_than_days || ' days')::interval
  returning 1;
$$;

-- ── Verification queries (run these after the sync daemon has been up a few minutes) ──

-- select count(*) from system_audit;
-- select * from system_audit order by id desc limit 5;
-- select active_count, completed_count, taken_at from queue_snapshot order by taken_at desc limit 3;
-- select * from dispatcher_status;

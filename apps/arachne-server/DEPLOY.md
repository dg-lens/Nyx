# Deploying arachne-server (Fly: `lens-arachne`, region `ord`)

The shared always-on service — collective memory **and** the pipeline gate relay.
Run these from the repo root with the Fly CLI authenticated. The Docker build uses
the repo root as context (pnpm monorepo), so it's referenced explicitly below.

## 1. App + Postgres
```bash
fly apps create lens-arachne
fly postgres create --name lens-arachne-db --region ord            # provision a dedicated cluster
fly postgres attach lens-arachne-db --app lens-arachne             # sets the DATABASE_URL secret on lens-arachne
```

## 2. First deploy
```bash
fly deploy --config apps/arachne-server/fly.toml \
           --dockerfile apps/arachne-server/Dockerfile .
fly logs --app lens-arachne          # expect "[arachne] listening on :8088"
curl https://lens-arachne.fly.dev/health   # {"ok":true}
```
The server runs `applyMigration` on boot, so both migrations apply on first start.

## 3. Per-platform tokens
Each Nyx instance authenticates with its own bearer token. The raw token is shown
once; only its sha256 is stored. Run the admin tool against the live DB (SSH into a
machine, or set `DATABASE_URL` locally to the Fly Postgres connection string):
```bash
# on a Fly machine:  fly ssh console --app lens-arachne  then:  cd /repo/apps/arachne-server
node dist/admin.js add-platform operator "Operator (Dylan)" read,write,gate_review
node dist/admin.js add-platform james    "James"            read,write,gate_push
node dist/admin.js list
```
- **operator** = your reviewing instance → `gate_review` (decides on relayed gates).
- **james** = origin instance → `gate_push` (pushes its gates for review).
- Both keep `read,write` for shared memory.

## 4. Store secrets in Bitwarden (`arachne` project)
```bash
BWS_ACCESS_TOKEN=$(cat ~/.config/bitwarden/arachne.token) \
  bws secret create NYX_ARACHNE_URL   'https://lens-arachne.fly.dev' <ARACHNE-PROJECT-UUID>
BWS_ACCESS_TOKEN=$(cat ~/.config/bitwarden/arachne.token) \
  bws secret create OPERATOR_ARACHNE_TOKEN '<raw operator token>'    <ARACHNE-PROJECT-UUID>
BWS_ACCESS_TOKEN=$(cat ~/.config/bitwarden/arachne.token) \
  bws secret create JAMES_ARACHNE_TOKEN    '<raw james token>'       <ARACHNE-PROJECT-UUID>
```
`DATABASE_URL` is managed by Fly (set by `postgres attach`) — no mirror needed.

## 5. Wire the instances
Each box's `~/Nyx/Data/.env` gets its own token:
```bash
NYX_ARACHNE_URL=https://lens-arachne.fly.dev
NYX_ARACHNE_TOKEN=<that box's raw token>
```
The gate-relay host plugin (next build step) reads these to push/poll; the memory
plugins reuse the same URL+token.

## Notes
- `min_machines_running = 1` keeps it always-on (gate polling + memory reads need it up).
- First `fly deploy` is the build's validation — the Docker build can't be exercised
  locally here. If pnpm/build flags need tuning, iterate on the Dockerfile.

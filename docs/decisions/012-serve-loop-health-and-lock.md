# 012 serve loop, heartbeat, healthcheck, lock

**Decided**

- `serve` runs a sync immediately, then waits `SYNC_INTERVAL_MINUTES` **after** each run finishes, so runs cannot overlap. SIGTERM/SIGINT stop new runs and let the current one finish (up to 25 s; compose `stop_grace_period: 30s`). A run killed anyway leaves a `running` row that the next start marks `failed` (decision 005); applying is idempotent.
- **A failed sync does not stop `serve`:** it is logged with code, what, why and action, recorded in the heartbeat, and retried at the next interval (60 s for `E_NOT_CONFIGURED`/`E_GOOGLE_CLIENT_MISSING`, which are local and cost no traffic). That is why compose can use `restart: unless-stopped` (decision 007): the container only restarts after a crash or an invalid `.env`.
- Each run builds the Google client again from the files, so `auth google` made while `serve` runs is picked up without a restart.
- **Heartbeat:** `DATA_DIR/heartbeat.json` (pid, start, last run, last success, status, error code, counts, next run). Healthy = loop alive and last success (ok or partial) not older than 3x the interval; a loop that keeps failing becomes unhealthy after 3 intervals. No heartbeat file (serve never ran in this folder, as in the CI docker job) = only the basic checks.
- **`healthcheck` no longer opens the state db with `StateStore.open`:** that call marks runs in progress as interrupted, which a healthcheck every 60 s would do to a running sync. `StateStore.probe` opens read-only.
- **Lock:** `DATA_DIR/sync.lock` (create-exclusive; stale after 20 min) so `serve` and a manual `docker compose run ... sync` never write together (`E_SYNC_ALREADY_RUNNING`). Dry runs take no lock.
- **Status endpoint:** `node:http`, no new dependency. `GET /status` (JSON: counts, codes, times; no titles, no URLs) and `GET /healthz` (200/503). Requests with a non-local `Host` get 421 (DNS rebinding). `STATUS_PORT=0` turns it off; a bind failure only logs a warning. The image sets `STATUS_BIND=0.0.0.0` (container side); compose publishes it on the host's `127.0.0.1` only.

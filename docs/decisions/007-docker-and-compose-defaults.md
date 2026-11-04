# 007 Docker and compose defaults

**Decided**

- `restart: "no"` in compose for now: `serve` is not implemented until M2 and exits with `E_NOT_IMPLEMENTED`, which would otherwise restart-loop. Switch to `unless-stopped` in M2.
- Port 8787 is published on `127.0.0.1` only (the wizard must never face the network). Nothing listens yet.
- Healthcheck = `node dist/main.js healthcheck`: data dir writable and `state.db` opens. M2 should add "last sync not older than 3x interval".
- Container: non-root `node` (uid 1000), `/data` volume, read-only root fs, `cap_drop: ALL`, `no-new-privileges`.
- `.env` is optional for compose (`required: false`); Node reads `.env` itself when run outside Docker.
- **Verification:** the CI `docker` job (GitHub runner, run 4 on branch `m0-m1`) builds the image, checks the user is not root, and runs `healthcheck` against a fresh named volume: green. Locally the multi-stage build succeeded once (with the sandbox's proxy CA injected into a scratch copy of the Dockerfile; the committed one is unchanged), but the container run could not be repeated here because Docker Hub rate-limited anonymous pulls (429). `docker compose config` validates; `docker compose up` was not exercised (nothing listens yet).

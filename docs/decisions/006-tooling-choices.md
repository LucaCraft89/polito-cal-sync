# 006 Tooling choices the docs did not fix

- **TypeScript 5.9, not latest (7.x):** `typescript-eslint` 8 supports `<6.1`. `@types/node` 22 to match Node >= 22.
- **`better-sqlite3` uses its shipped prebuilt linux binaries.** Its implicit `node-gyp` build is disabled (`pnpm.ignoredBuiltDependencies`), so the Docker image needs no compiler. Verified: clean install works, image builds.
- **`pnpm doctor` does not run our `doctor`:** it is a pnpm built-in and shadows the script (it silently exits 0). Use `pnpm run doctor` or `node dist/main.js doctor`. AGENTS.md lists `pnpm doctor`; left unedited (not ours to change), flagged here.
- **`googleapis` types:** use `Auth.OAuth2Client` from `googleapis`; `google-auth-library` is only transitive and not importable under pnpm.
- Prettier ignores the owner-written docs (`AGENTS.md`, `CLAUDE.md`, `docs/PLAN.md`, `docs/RESEARCH.md`) so `pnpm format` never rewrites them.

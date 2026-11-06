# 004 `sync --fixture` and the in-memory calendar

M1 must be demonstrable with no Google or Polito credentials, and the Google OAuth flow is M2. AGENTS.md says "mocks are for tests only".

**Decided**

- `src/google/memory.ts` (fake Google `events` API, models 409 on reused ids, tombstones, paging, filters) lives in `src/` because the developer-only flag `sync --fixture DIR` uses it. It is never selected by env or default.
- Fixture mode prints a banner saying nothing real is read or written. Without `--fixture`, `sync` stops with `E_NOT_CONFIGURED` ("Google is not connected yet"). It does **not** pretend to sync.
- README states plainly: M1 has no real source and no real Google login. `OwnedCalendar` + the `googleapis` adapter exist and are unit-tested, but have not talked to Google yet.

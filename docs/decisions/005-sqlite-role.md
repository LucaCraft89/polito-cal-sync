# 005 What sqlite is for

AGENTS.md says "sqlite sync state" without saying what is authoritative.

**Decided**

- The calendar is the source of truth for diffing: every event we write carries `hash`, `source`, `sourceId`, `kind` in private extended properties. Losing `state.db` therefore loses history only, never correctness (the next run re-reads the calendar).
- sqlite holds: run history (counts, status, error code, ids of failures; **never event text**) and a mirror of what was last written, for the status page and `doctor`.
- A dry run writes nothing, not even a history row. A run found `running` at next start (crash) is marked `failed`.
- File mode 0600, WAL, schema versioned with `user_version`; a newer schema is refused (`E_STATE_DB_SCHEMA_NEWER`).

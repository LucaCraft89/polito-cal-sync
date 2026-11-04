# 001 Deletion threshold: what exactly is refused

AGENTS.md says "refuse if > 30% of managed events would go; require `--force`" but not what is refused or what the 30% is of.

**Decided**

- The **whole run** is refused (no creates/patches either). A source that suddenly loses most events is suspect, so none of its output is applied. The run is recorded as `refused` in sqlite.
- The base is the managed events whose source returned a **complete** result, not all managed events (a bigger base would weaken the protection). Strictly greater than the limit refuses: 3 of 10 passes, 4 of 10 does not.
- A complete source that returns **nothing** while we manage events for it is the 100% case: refused.
- Incomplete sources never delete and never count toward the base.
- Limit is `DELETE_THRESHOLD` (default 0.3). `--dry-run` shows "would be REFUSED" and exits 2.

**Consequence:** a student with very few events (e.g. 2) hits the limit on a single deletion and needs `--force`. Accepted for now; revisit after M2 with real data.

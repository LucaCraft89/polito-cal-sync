# 008 Config limits, error docs, secret scan

- **`SYNC_INTERVAL_MINUTES` must be 15..1440** (docs only gave the default 60). Honours "low traffic". `DELETE_THRESHOLD` (0..1, default 0.3) and `LOG_LEVEL` are new env vars, in `.env.example`.
- `DATA_DIR` defaults to `./data` when run locally; the image sets `/data`.
- Config errors name the variable and the rule, **never the value**.
- `docs/ERRORS.md` is hand-written; `test/errors-doc.test.ts` fails if a code exists in `src/util/errors.ts` without a section (or the reverse), or a section lacks what/why/what-to-do.
- **Secret scan** (`scripts/secret-scan.ts`, in `pnpm check`) scans tracked and not-ignored files: Google client secret/id/tokens, PEM keys, JWTs, GitHub tokens, bearer tokens, `user:pass@` URLs, Moodle `authtoken=`, literal `password = "..."` assignments, non-placeholder values for secret-like keys in `.env.example`, and forbidden file names (`.env`, `*.pem`, `*.sqlite`, `data/`, `tokens.json`...). It prints file:line and rule, **never the matched text**. `secret-scan:ignore` on a line skips it. The same patterns redact logs and error text.

# Polito API fixtures: INVENTED, derived from the spec summary

**These are not real.** They were written by hand from the field table in `src/sources/polito/fields.ts`
(names tagged `SPEC` come from the public API description, names tagged `GUESS` are by analogy). They test the
mapper and the fail-closed behaviour. They prove nothing about what the real server returns.

Real, sanitized samples from the owner's probe go in `test/fixtures/polito/real/` (does not exist yet) and
should then replace these as the reference; see `docs/M3-RUNBOOK.md`.

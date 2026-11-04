# Research notes (as of 2026-11-04)

Confidence: **V** verified by reading the primary source, **S** seen in search results only, **U** unverified.

## Is this allowed?
No source found either permits or forbids it. Nothing here is legal advice.
- V — Polito's "Regolamento Generale LAIB" governs the basic computer labs. Clause 1.3.9: the account is strictly personal, forbidden to cede to third parties; the user is responsible for actions done with it. Nothing about automated access. No general IT-use policy was found. Self-hosting keeps credentials with the owner.
- V — Licenses: `polito/students-app` and `polito/rn-apps` are EUPL-1.2; `polito/api-spec` shows no license. Hence the clean-room rule in AGENTS.md.
- S — Third-party clients exist for years: `open-polito/open-polito-api` (AGPL-3.0, old API), `polito_api_flutter` (EUPL-1.2, generated from the spec), `FAZIO11/polito-mcp`, `MartinoMensio/polito-aule-bot`, `SuperTost100/areadidattica-cli`, `carlo-/ipolito`, and video downloaders. No sign of Polito objecting, no sign of approval. Their code was not read.
- V — The API spec repo describes no public developer program or published auth scheme.
- Recommendation: the owner emails Polito ICT / the app maintainer (contact in `publiccode.yml`) before relying on the credential-based path.

## Calendar sync is not offered officially
V — `polito/rn-apps` discussion #164 (was issue #141): maintainers prefer per-course subscribable ICS feeds over syncing into the system calendar.

## MFA / login
- V — https://it.polito.it/en/support/manuals/mfa-and-login-to-the-politecnico : MFA mandatory for staff; for students optional per service, **but once a factor is registered it is required to access the student app**. Methods: SMS OTP, passkey, authenticator apps. Trusted-device session lasts 90 days; new devices prompt MFA again. Login through idp.polito.it (SSO, also CIE/SPID).
- V — Spec: `POST /auth/login` basic | sso; `/auth/mfa/enrol` (description, pubkey -> serial), `/validate` (serial, nonce, signature), `/challenge`, `/status`; `GET /auth/profile/token?type=card|event`. Token lifetime not stated.
- U — whether a headless client can complete MFA, how the app obtains `sso` `uid`/`key`, token lifetime.

## API facts (from api-spec TypeSpec, V unless noted)
See AGENTS.md "Known facts". Date semantics: exams and bookings use UTC datetimes; deadlines and lectures query use plain dates. Assignments have no due date. Lecture model fields: U.

## Moodle
S/U — nothing Polito-specific found. Generic Moodle: calendar export URL with a per-user auth token (`/calendar/export.php`), `tool_mobile` token via web services, assignment due dates in the calendar. The probe must determine what moodle.polito.it exposes. Preferred: export URL (no password at runtime).

## Environment note
The cloud sandbox shell can reach polito hosts but cannot read other GitHub repos. Recon that needs the owner's credentials runs on the owner's machine, never in the cloud session.

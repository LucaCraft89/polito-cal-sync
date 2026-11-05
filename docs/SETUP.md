# Setup guide

Everything below is done once. Nothing here asks you to paste a password or token into a chat, an issue or a commit: they go only into the web page on your own machine (or your own `.env`).

**Unofficial.** polito-cal-sync is not affiliated with or endorsed by Politecnico di Torino. It is for one person's own schedule, on their own machine.

## 1. Start it

With Docker (the always-on way):

```bash
docker compose up -d
```

Without Docker (needs Node >= 22 and pnpm):

```bash
pnpm install
UI_ENABLED=true pnpm serve
```

With Docker, add `UI_ENABLED=true` to a `.env` file next to `docker-compose.yml` first (copy `.env.example`). Then open **http://localhost:8787**. The page is only reachable from the machine it runs on.

The first time, the page asks you to choose a **passphrase** (12 characters or more). It protects the page, because the page can change what is written to your calendar and holds your university login. If you forget it: `pnpm reset-ui-passphrase` (or the same command inside the container) on that machine.

The **Overview** page then lists the steps in order and shows the next one.

## 2. Create the Google client (about 10 minutes, once)

Google needs to know which app is asking for access. You create a private one. Menu names change now and then; the idea stays the same.

1. Open https://console.cloud.google.com/ and create a project, for example `polito-cal-sync`.
2. **APIs & Services → Library**: search "Google Calendar API" and press **Enable**.
3. **Google Auth Platform** (or "OAuth consent screen"): choose **External**, give the app a name, use your own email as contact. Add nobody else.
4. **Clients → Create client**: type **Desktop app**. Copy the **client ID** and the **client secret** (treat the secret like a password).
5. **Publish the app** ("Audience" → "Publish app", status **In production**) **before** you sign in. In "Testing" mode Google ends the login after 7 days and the sync stops with `E_GOOGLE_AUTH_EXPIRED`. For a personal client no Google review is needed; at sign-in Google shows "Google hasn't verified this app": press **Advanced → Go to polito-cal-sync (unsafe)**. It is your own app.

In the web page, open **Settings → Google**, enter the client ID and the secret, press **Save**.

## 3. Connect Google and choose the calendar

Still on **Settings**, in "Google account and calendar":

1. Press **Connect Google**, then **Open the Google sign-in**. Sign in, tick the calendar permission, press Continue. The page notices by itself and shows your account.
2. Press **Create the dedicated calendar** (default name "Polito (polito-cal-sync)"), or **Pick one of my calendars**. Your **main calendar is never offered and never accepted**; the program only ever changes events it created, in this one calendar. It never deletes a calendar.

With Docker the sign-in comes back to port **8789** of your machine; `docker-compose.yml` already publishes it on `127.0.0.1` only. (This Docker path has not been run by the author.)

## 4. Add your sources

Open **Sources**. Each card has a **Test** button that checks it without saving or writing anything.

- **Calendar feeds.** Paste the feed link of a course calendar (it contains a secret token, so the page never shows it again, only its host). A Moodle calendar export link works here too, with limits: see "Moodle" below.
- **Polito portal** (optional, read this first). The program logs in to the student portal the way a browser does, with your university username and password, and reads your lectures, booked exams, bookings and deadlines. The password is stored in a file only you can read on this machine (not encrypted: protect the disk). It is not an advertised interface and can break when the portal changes. If the university shows an extra login step (multi-factor), the source stops with `E_POLITO_LOGIN_EXTRA_STEP` and the feeds keep working. If the university **refuses** the password, no new attempt is made until you change it (so a wrong password is never retried every hour and your account is not locked); you can lift that pause on the **History** page after checking the login in a browser. Press **Save**, then **Test login**.
- **Squads.** If your courses split students into squads, run a preview once; the **Sources** page then shows one checkbox group per course. Tick your squad. Nothing ticked keeps every squad.

## 5. Preview, then sync

On **Preview**, press **Preview now**. It reads your sources and your calendar and **writes nothing**; it shows what would be added, changed and removed. When it looks right, press **Sync now** and confirm. If it would remove more than your limit (default 30%), you must type `remove N` first, because that usually means a source came back empty.

After that the scheduled sync keeps the calendar up to date (every 60 minutes by default; change it under Settings, 15 to 1440). **History** shows every run.

## 6. Check the setup any time

```bash
pnpm run doctor
```

Checks the data folder, the clock, the history database, the Google login and calendar, every source and the last sync, and prints each problem as what happened, why and what to do. `--local` makes no network request. (`pnpm doctor` without `run` is a pnpm built-in and does nothing useful.)

## Moodle

Two ways, pick one (using both shows every event twice):

- **Live Moodle events (recommended).** On **Sources → Moodle**, switch on "Live Moodle events" and press **Test Moodle**. It reads your Moodle calendar through Moodle's app service on every sync, from a year back to a year ahead, with the course of each event, and needs **no link to copy or regenerate**. It uses the same university username and password as the Polito portal card (save them there; the portal switch can stay off). It logs in once through the university single sign-on, keeps the app token in the data folder (a private file) and reuses it until Moodle refuses it, so a normal sync is three small requests. A refused password is paused for both Moodle and the portal (one account, one pause). If the university ever asks for an extra login step, the source stops and says so. Events from a Moodle feed that you added earlier become duplicates: remove that feed first.
- **The calendar feed link.** Works without a password, but the export is limited by its time window. Take the link from Moodle's "Import or export calendars" and change `preset_time=recentupcoming` at the end to `preset_time=custom` (about a year ahead); the other choices stop after about 15 days. It holds nothing from before the 1st of the current month. Each fetch is fresh, not a one-time export.

Evidence and the limits of what was measured (one account): `docs/decisions/033` to `036`.

## Limits to know

- This writes to your real Google Calendar, into a calendar of its own.
- The web page stores your Polito password and the Google client secret in clear text in the data folder (mode 0600). Docker volume or disk encryption is your protection.
- Not built yet: one calendar per course.
- The live Moodle source was verified against an invented Moodle in tests and its login and calls were shaped from probe runs on one real account; the program itself has not synced from the real Moodle yet. The token's lifetime is unknown (it is simply replaced when Moodle refuses it).
- Run against real Google: **not yet by the author** (see README, "What is tested").

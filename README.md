# Nutricost IT Assets

A mobile-first web app for tracking Nutricost's IT equipment: computers, monitors, peripherals, phones, appliances and software licenses. It records who has each item, handles check-out and check-in, lets IT ask for items back, scans barcodes, stores photos, and sends email through Google Workspace.

It runs on phones, tablets and desktops. On a phone, users can add it to the home screen and it opens like a regular app.

---

## What it does

| | Admins (IT) | Users (employees) |
|---|---|---|
| **Dashboard** | Totals, overdue items, open requests, warranties and licenses expiring soon, recent activity | Their own equipment and any return requests |
| **Assets** | Add, edit, retire, mark lost, disposed or in repair, archive; add photos | See what's available and what they have |
| **Check out** | Assign an item to anyone, with a due date and condition | Scan an available item and check it out to themselves (can be turned off) |
| **Check in** | Scan the item, record its condition and where it goes, optionally mark it in repair | Tap "I'm returning this" |
| **Return requests** | Ask a person to turn an item in by a date; they get an email and a banner in the app | Tap "I've dropped it off", which emails IT |
| **Equipment requests** | Assign an asset to the request (checks it out), approve it, or decline it | Ask IT for equipment |
| **Barcodes** | Scan to find an item. Scanning one of our own labels that has no asset yet opens Add asset with that tag; any other unknown code offers a new asset with it as the serial number (or the tag). Print Code 128 labels from the Add asset form, as numbered blank sheets (Create labels) or for saved assets (Print labels). | Scan to find an item |
| **Software licenses** | Seat counts (for example 3 of 25 used), license key, renewal date | See the license key for seats assigned to them |
| **People** | Invite people, set admin or user, deactivate, see each person's current and past equipment | Their own profile |
| **Data** | CSV import (bulk onboarding) and export, full activity log per asset | |

**Emails sent automatically:** welcome/invite, password reset, checked out to you, return received, please return, dropped-off alert (to IT), new equipment request (to IT), request approved or declined, self check-out alert (to IT), overdue reminder (on the due date, then every 3 days). Waitlist (informational notice to the current reserver when another team joins; "available for you, confirm within 24 hours" to the next person in line). **Settings → IT email** sets the display name and the IT contact / reply-to address; passwords and keys stay in `.env`.

**Barcode scanning** works three ways:
1. **Phone or tablet camera.** Tap Scan. It reads Code 128, Code 39, UPC/EAN, QR, Data Matrix and more. This needs **https**.
2. **USB or Bluetooth handheld scanner.** On a desktop the Scan page's input box is focused automatically, so scanning there works right away.
3. **Typing** the tag or serial number.

You can put the app's own labels on devices, or reuse barcodes that are already on the device. Own labels (Avery 5160/8160 sheets or a label printer), all under **All assets**:
- **Add asset → Print label:** the form shows the next free tag and its label; printing reserves that number for the asset. Cancelling without printing reserves nothing.
- **Create labels:** print a batch of numbered labels first (the numbers are reserved at once and never given to another asset), stick them on the devices, then scan each one: Add asset opens with that tag. If the sheet did not print or is not needed, **Give the numbers back** (the app asks after the print dialog closes) and the next labels reuse them, as long as no newer numbers were issued meanwhile.
- **Print labels:** labels for assets already added.

To reuse a maker's barcode, scan it: the app offers a new asset with it as the serial number (scanning the serial finds the asset later), or as the tag.

---

## Quick start (local test)

Requires **Node.js 20.12 or newer**.

```bash
npm install
cp .env.example .env      # edit it (see "Email" below). Can be left as-is for a local test.
npm start
```

Open http://localhost:3000. The first visit asks you to create the first **admin** account. Then:
1. **Settings**: check the categories, locations and check-out rules.
2. **People → Add person**: each person gets an email invite to set their password.
3. **Add assets** one by one (scan, fill in, take photos) or **Import / export → Import CSV** for bulk onboarding. A template is available there.
4. **Labels:** print one from the Add asset form, or print numbered blanks first (**All assets → Create labels**), stick them on the devices and scan each one to add it.

Emails are saved to **Settings → Outbox** until SMTP is configured, so everything can be tested without sending real mail.

---

## Development dataset (seed)

For local development you don't have to add data by hand. `npm run seed:dev` wipes and rebuilds an **isolated** database at `./data-dev` (never touches the real `./data`) with 9 people, 55 realistic assets (tags `NC-00001`–`NC-00055`), a demonstration **equipment catalog** (Laptop › Mac › MacBook Air › M2, Camera › Sony › A7 IV, …), and a mix of current/past assignments, requests and activity history.

```bash
npm run seed:dev
DATA_DIR=./data-dev PORT=3000 npm run dev
```

Then open http://localhost:3000 and log in as the seeded admin:

- **Email:** `dana.ito@example.com`
- **Password:** `DevPass!2026`

Every seeded account (admin and regular users) shares that same development-only password. `./data-dev` is gitignored — it's disposable scratch data, safe to delete or reseed at any time, and is **never** used by `npm start` unless you set `DATA_DIR` yourself as shown above.

`npm run dev` is the way to run the app while developing: it restarts the server itself when backend files change, and the browser is told to cache nothing (and no service worker is kept), so a normal page refresh always shows the current code. `npm start` does **not** restart on changes, so a backend edit would need a manual restart. If the port is already taken the server now says so instead of silently leaving the old process in charge.

**Don't run `npm run seed:dev` while `npm run dev` is using `./data-dev`** — it deletes and recreates that database underneath the running server, which can leave the watcher on a stale file and crash it. To check that the seed still works (agents, CI, a quick manual check) use the isolated variant instead:

```bash
npm run seed:verify
```

It seeds the same dataset into a temporary directory, confirms setup is complete and the admin login above works, deletes the temporary directory, and exits non-zero on failure. It never touches `./data-dev`, so it is safe to run while your dev server is up.

---

## Testing on a real phone

To try the mobile layout on an actual phone, run the dev server on your Mac and open it from the phone on the same Wi-Fi network:

1. Put the Mac and the phone on the same Wi-Fi.
2. Get the Mac's LAN IP: `ipconfig getifaddr en0`
3. Start the app: `DATA_DIR=./data-dev PORT=3000 npm run dev`
4. On the phone, open `http://<MAC-LAN-IP>:3000`
5. If macOS asks whether to allow Node to accept incoming connections, choose **Allow**.

Do **not** run `npm run seed:dev` just to test from the phone. It deletes and rebuilds `./data-dev` underneath the running server; the dataset is already there if you've seeded it once.

This is for checking layout, navigation and scrolling on a real device. The phone camera scanner still needs **HTTPS** (browsers only allow camera access on secure pages), so on a plain `http://` LAN address you'll get the "needs a secure connection" message and can type the tag instead.

---

## Deploying for the company

### Option 1: Docker (recommended)

```bash
cp .env.example .env     # fill in APP_URL, SESSION_SECRET and the Gmail settings
docker compose up -d --build
```

The database and photos are stored in `./data`. **Back up this folder.** It is the whole system.

### Option 2: Plain Node on a server or VM

```bash
npm ci --omit=dev
npm start                # run it under systemd, pm2 or similar so it restarts automatically
```

### HTTPS (required for phone camera scanning)

Put the app behind a reverse proxy with a certificate: Caddy, nginx, Cloudflare Tunnel, or your cloud provider's load balancer. With Caddy it is two lines:

```
assets.nutricost.com {
  reverse_proxy localhost:3000
}
```

Set `APP_URL=https://assets.nutricost.com` in `.env` so links in emails point to the right place and cookies are marked secure.

If the app should only be reachable inside the office network or VPN, host it internally with an internal certificate. Scanning still works as long as the address is https.

---

## Local PostgreSQL (preparation)

**The app still runs on SQLite.** Nothing in `src/` uses PostgreSQL yet; this is only the local tooling for the planned migration (decision D-46). It needs Docker, and `npm install` (the `pg` driver is a dev dependency).

```bash
npm run db:up      # start PostgreSQL 18 on 127.0.0.1:5433 and wait until it is healthy
npm run db:check   # print server version and time zone, then "connected" (local hosts only)
npm run db:down    # stop it, keep the data
npm run db:reset   # stop it and delete the data volume (local only)
```

The dev credentials (`nc_dev` / `nc_dev`, database `nc_assets_dev`) are in `docker-compose.postgres.yml` and must never be reused anywhere else. `db:check` refuses any host other than localhost, so a Railway URL can never be used by accident.

## Tests and CI

```bash
npm test               # the whole suite on SQLite; the PostgreSQL tests (test/pg) run too when the local database is up, else skip
npm run test:pg        # only the PostgreSQL tests, PostgreSQL required (npm run db:up first)
npm run test:pg-suite  # the whole suite on the PostgreSQL driver plus test/pg, PostgreSQL required
```

At most 4 test files run at once: the PostgreSQL lock and timeout tests are timing-sensitive and flaked under more load.

**CI** (`.github/workflows/ci.yml`, GitHub Actions) runs `npm test` and, against a `postgres:18` service container with the
same dev-only credentials, `npm run test:pg-suite`, on every pull request and on every push to `stage`, `main` and
`integration/postgresql`. It uses no secrets and deploys nothing. A red check means do not merge until it is understood.

---

## Planned production direction (not yet built)

The setup above (Docker or plain Node, with local SQLite) is what actually works today. The intended longer-term production direction is:

- **Application hosting:** Railway. The team doesn't have Railway account/project access yet — an administrator is setting that up, with no confirmed completion date.
- **Database:** managed PostgreSQL, described and built provider-neutrally rather than locked to one vendor. **Railway PostgreSQL is the current preferred host.**
- **File/photo storage:** S3-compatible object storage, also provider-neutral. **Railway object storage (or another S3-compatible provider) is the current preferred direction.**
- **Authentication:** **Google sign-in is built** (beside the password login; see "Google sign-in" below). Still to come: an email/magic-link fallback, and deciding whether the password login is retired. Other requirements: persistent authenticated sessions, separate admin vs. employee authorization enforced by the backend (not by hostname), and pre-provisioned employee linking (an employee can exist and hold equipment without ever having a login).
- **Portals:** a separate employee-facing portal is planned alongside this admin app, sharing the same backend, database, and authentication system — there's no separate inventory data per portal. Both are expected to live on separate subdomains of an existing hosted parent domain/site (not a new domain bought for this project); the exact parent domain and both subdomains are still TBD, and no DNS has been configured. Session/cookie behavior across the two hostnames will be decided during the authentication work, not assumed now.

See `PROJECT_STATUS.md` for the full roadmap and current status of each of these.

---

## Email (Google Workspace / Gmail)

Set it up in `.env` (option A below); the app needs a restart afterwards.

**A. Mailbox and App Password (simplest)**
1. Use or create a mailbox such as `it@nutricost.com`.
2. Turn on 2-Step Verification for that account.
3. Go to Google Account → Security → **App passwords** and create one called "IT Assets".
4. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=it@nutricost.com
   SMTP_PASS=<the 16-character app password>
   MAIL_FROM="Nutricost IT <it@nutricost.com>"
   ```
   If App passwords don't appear, a Workspace admin needs to allow them, or you can use option B.

**B. Workspace SMTP relay:** *not supported yet.* The mailer only starts when **both** `SMTP_USER` and `SMTP_PASS` are set (it always signs in), so an IP-allow-listed relay without a password cannot be used. If App passwords are blocked for your Workspace, ask a Workspace admin to allow them for the sending mailbox.

**Every variable the mailer reads:** `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`; other ports use STARTTLS), `SMTP_USER`, `SMTP_PASS` (the App Password), `MAIL_FROM` (optional, defaults to `SMTP_USER`), `APP_URL` (links in emails), plus the optional `MAIL_ALLOW_IT_FROM`, `APP_TIMEZONE` and the testing-only `MAIL_TEST_RECIPIENT`. Credentials live only in `.env` (locally) or Railway secrets, never in the database or Settings.

**Seeding and tests never send email.** `npm run seed:dev`, `npm run seed:verify` and `npm test` are safe to run even with your real `SMTP_USER` / `SMTP_PASS` / `MAIL_TEST_RECIPIENT` in `.env` or your shell: they set `NC_NO_EXTERNAL_MAIL=1` before the app loads, which makes the app skip `.env` and never create an SMTP connection (seeded invites are only recorded in the Outbox as "Not sent"). You do not need to disable anything first. A normal `npm run dev` / `npm start` is unaffected.

**Testing real email locally (seeded users are `@example.com`).** In your own `.env` set `SMTP_USER` + `SMTP_PASS` (your work mailbox + its App Password) and `MAIL_TEST_RECIPIENT=<your real work email>`, then run `npm run dev` against the seeded data. Every email the app sends (waitlist notices, invites, reminders…) is delivered to *you*, with `[DEV for <intended recipient>]` in the subject and a banner naming who it was meant for; Settings shows a yellow "Email test mode" notice. **Settings → Outbox is a development/debug record only**: a row means the app *tried* to send (`Not sent` = email isn't configured, nothing left the app; `Sent` = the mail server accepted it; `Failed` = rejected, with the reason). It never means the recipient received anything.

To check it, go to **Settings → Send me a test email**. The Outbox shows each message as sent, failed (with the reason) or not sent.

---

## Google sign-in

Off until it is configured: with both variables below set, the login screen shows **Sign in with Google** above the password form (which stays).

Who gets in: anyone with a verified `GOOGLE_HOSTED_DOMAIN` Google account. On their **first** sign-in the app gives them a login with the **Employee** role: linked to their People record if IT already added them (matched by work email), otherwise as a new person named from their Google profile. **Admin is given by IT** (People → edit → Access), or, for the first admin of a new environment, by listing the address in `GOOGLE_ADMIN_EMAILS` (comma-separated; that person becomes an admin when they sign in with Google; never removed by the app). Refused: a person IT deactivated, a login IT turned off, or an address that is already someone else's login.

Setup (once, in the Google Cloud Console, signed in with a company account):
1. Create a project inside the company organization.
2. **Google Auth Platform / OAuth consent screen:** audience **Internal** (only company accounts; no Google review).
3. **Clients → Create client → Web application.** Authorized JavaScript origin: the `APP_URL` (e.g. `http://localhost:3000`); authorized redirect URI: `APP_URL` + `/auth/google/callback`. Add one pair per address the app runs on (local, staging, production).
4. Put the client ID and secret in `.env` (locally) or the host's secrets (Railway), never in the database or Settings:
   ```
   GOOGLE_CLIENT_ID=<…apps.googleusercontent.com>
   GOOGLE_CLIENT_SECRET=<GOCSPX-…>
   # GOOGLE_HOSTED_DOMAIN=nutricost.com   (the default)
   # GOOGLE_ADMIN_EMAILS=you@nutricost.com   (optional: made admins at Google sign-in)
   ```
5. Restart the app.

`APP_URL` must match the address in the browser exactly, or Google answers `redirect_uri_mismatch`.

---

## Branding

The colors are CSS variables at the top of `public/app.css`: `--brand-ink` (black) and `--brand-accent` (blue). Change them to match the official brand values. The logo is `public/logo.png` (blue, for light backgrounds: the sign-in panel) and `public/logo-white.png` (for dark backgrounds: the black header, the loading screen and the sign-in panel in dark mode); replace them with files of the same names to change it. The app icons are `public/icon.svg`, `icon-192.png` and `icon-512.png`.

## Security notes

- Passwords are hashed with bcrypt. Sessions last 30 days and are stored in the database. Logins are rate-limited.
- Google sign-in uses the authorization-code flow with PKCE, a single-use `state` and a `nonce`; the app checks the ID token's issuer, audience, expiry, verified email and Workspace domain, and never sees a Google password. Refused Google sign-ins are rate-limited per IP like password logins.
- Users only see available items and their own items. Purchase cost, vendor, notes and license keys stay hidden unless the user holds that item.
- A deactivated person is signed out immediately. Their assignment history is kept.
- Photos are resized automatically (to at most 1600px, and EXIF data is stripped). Only signed-in users can view them.

## Project layout

```
src/server.js     API, auth, check-out logic, CSV import/export, overdue reminders
src/db.js         SQLite schema and settings
src/mailer.js     Email templates and Gmail SMTP
public/           Front end (no build step): index.html, app.js, app.css, logos, PWA files
data/             Created at runtime: assets.db and uploads/ (back this up)
```

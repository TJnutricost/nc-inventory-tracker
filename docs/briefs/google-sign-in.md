## Slice brief: Google sign-in (beside the existing password login) — SECURITY-SENSITIVE

Status: APPROVED 2026-10-26; built 2026-10-26, awaiting review (see "As built" at the end).
Base: origin/integration/postgresql (head 34cae91 = PR #51 / Slice 6 merged). Branch feature/google-sign-in. PR into integration/postgresql
ONLY. NEVER merge. No stage/main, no Railway.

### Why now, and what the owner decided (2026-10-26)
- D-10 already names Google sign-in as the primary employee login (magic link as fallback; pre-provisioned people only; a verified login
  links to an EXISTING employee by normalized work email; an unknown login is blocked and never creates anyone).
- Start now, on the integration branch, not after Slice 7: the change touches both drivers (`src/accounts.js` and `src/pg/accounts.js`),
  which both live on this branch, so nothing has to be merged across later.
- The email + password login STAYS for now (a way in if the Google setup breaks). Removing it, and the magic-link fallback, are later
  decisions, out of scope here.
- Google side is done by the owner: Cloud project "NC IT Scanner" under the nutricost.com organization, consent screen audience
  **Internal**, web client "NC IT Scanner web" with origin `http://localhost:3000` and redirect URI
  `http://localhost:3000/auth/google/callback`. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are in the local `.env` (git-ignored). The
  Railway URIs and variables are added only when this reaches staging.

### Goal
A "Sign in with Google" button on the login screen. A nutricost.com employee who already has an active login in the app is signed in
exactly as a password login signs them in (new session id, `uid` = account id, `last_login_at` recorded). Anyone else is refused with a
plain message and nothing is created. The app never sees or stores a Google password.

### Design
- **Flow:** standard OAuth 2.0 / OpenID Connect authorization-code flow with PKCE, server side, outside `/api` (plain browser navigations):
  - `GET /auth/google`: random `state`, `nonce` and PKCE verifier kept in the session; redirect to Google with `scope=openid email`,
    `hd=<domain>` (a hint only), `prompt=select_account`, `redirect_uri=${APP_URL}/auth/google/callback`.
  - `GET /auth/google/callback`: `state` must match (single use; cleared either way); the code is exchanged at Google's token endpoint
    with the client secret and the verifier; the returned ID token is checked, then the account is looked up. Success: regenerate the
    session, set `uid`, record the login, redirect to `/#/home`. Any failure: redirect to `/#/login?error=<code>`; the login screen shows
    a fixed message for the code (no Google error text is echoed).
  - The session cookie is `SameSite=Lax`, so it travels on Google's top-level redirect back; no cookie setting changes.
- **ID token checks:** `iss` is `https://accounts.google.com` (or `accounts.google.com`), `aud` = our client id, not expired, `nonce`
  matches, `email_verified` is true, and **`hd` equals `GOOGLE_HOSTED_DOMAIN`** (default `nutricost.com`). The Internal consent screen
  already limits sign-in to the organization; the `hd` check is the app's own backstop. The token is received directly from Google's
  token endpoint over TLS with our secret, which OpenID Connect Core §3.1.3.7 accepts in place of a signature check, so **no new
  dependency** (Node's `fetch` and `crypto` only).
- **Who may sign in (D-10):** the Google email, trimmed and lower-cased, must equal an **active employee's work email**, and that
  employee must have a linked **active account**. New seam function `accounts.googleAccount(email)` on both drivers (SQLite: `work_email`
  is NOCASE; PostgreSQL: `lower(e.work_email) = lower($1 COLLATE "C")`, idiom (ap)), returning the same row shape as `loginAccount`.
  Refused, with nothing written: no employee with that work email ("not registered"), an employee with no login or a disabled login, an
  inactive employee ("ask IT"). An account with no employee, or an employee without a work email, keeps using the password.
- **A pending invite:** a person IT gave a login who never set a password can sign in with Google (they are pre-provisioned and the
  email is verified). The invite / reset emails are unchanged.
- **Off unless configured:** the routes answer 404 and the button is hidden unless `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both
  set (the same pattern as mail). The login screen learns it from a new `GET /api/auth-options` (`{ google: true|false }`; no secret leaves the
  server; `GET /api/setup-needed` is unchanged).
- **Rate limiting:** the callback shares the login route's per-IP limiter (10 failures / 15 min) so a stream of refused callbacks cannot
  run unbounded.
- **Two hostnames (D-08):** the redirect URI is built from `APP_URL`. A second portal hostname needs its own URI in Google and is out of
  scope (hostnames are still TBD).

### Files
New `src/googleAuth.js` (URLs, PKCE, token exchange, claim checks; the endpoints injectable for tests); `src/server.js` (two routes, the
flag in `/api/setup-needed`); `src/accounts.js` + `src/pg/accounts.js` (`googleAccount`); `src/dataSeam/sqlite.js` + `src/dataSeam/pg.js`
(bind it); `public/app.js` + `public/app.css` (button, error message); `public/sw.js` (leaves `/auth/` to the network); `.env.example` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_HOSTED_DOMAIN`, with setup notes); README sign-in section. No schema change, no new npm package.

### Tests
A fake Google token endpoint (local HTTP server) issues ID tokens, so no test reaches Google. Cases: success signs in the right account
and rotates the session id; bad / missing / reused `state`; `nonce` mismatch; wrong `aud`; wrong or missing `hd`; `email_verified`
false; expired token; token endpoint error; unknown email; employee without login, disabled login, inactive employee; case and whitespace
in the email; routes 404 and button flag false when not configured; the password login still works. `googleAccount` gets a differential
SQLite-vs-PostgreSQL test, and `test/pg/seam-parity.test.js` must still pass.

### Verification
Full suite on SQLite and on PostgreSQL (`npm run test:pg-suite`), 0 failures beyond the known pre-existing cancelled harness test. Then a
real sign-in on `http://localhost:3000` with the owner's Google account against the local dev data (the owner's work email must belong to
an active employee with a login there). No Railway, no real email.

### As built (2026-10-26)
- `src/googleAuth.js`: `config`, `start`, `finish`, `checkClaims`, `SignInError`; Google's endpoints in an exported `endpoints` object (the
  tests point `endpoints.token` at a local fake). A pending sign-in expires after 10 minutes; the token request times out after 10 s.
- Routes in `src/server.js`: `GET /api/auth-options`, `GET /auth/google`, `GET /auth/google/callback`. Refusal codes on
  `/#/login?error=`: `not_registered`, `domain`, `unverified`, `token`, `google`, `state`, `cancelled`, `too_many`; `token` and `google`
  are also logged (`[google sign-in]`), never shown. The limiter key is `<ip>|google`, in the same map as the password login's.
- `accounts.googleAccount` on both drivers, bound in `src/dataSeam/sqlite.js` (the PostgreSQL seam binds the same list).
- `test/data-seam-ratchet.test.js`: the callback is in MIGRATED, `/api/auth-options` and `/auth/google` in NO_OWN_SQL, and
  `./googleAuth` is an allowed local module of server.js (no database access).
- Tests: `test/google-sign-in.test.js` (end to end, both drivers), a not-configured test in `test/auth.test.js`, and a `googleAccount`
  differential case in `test/pg/pg-accounts.test.js`.
- Docs: README "Google sign-in" (setup steps) and security note, `.env.example`.

### Revision 2026-10-27 (owner): first sign-in creates the login (D-10 revised)
The owner chose self-registration for the company domain after the first staging test was refused ("no login here").
- Lookup unchanged first (`googleAccount`). When it finds nothing, `accounts.provisionGoogleAccount({ email, name })` (both drivers, ONE
  transaction): an active employee with that work email and no login gets a login linked to them; nobody with that work email: a new
  employee (Google's `name`, else the address's local part; control characters removed, at most 100 characters) and its login. Role is
  always `employee`, no password. Refused (`/#/login?error=no_access`, nothing written): the employee is inactive, their login is turned
  off, or the address is another person's login. The `not_registered` code is gone.
- Scope is now `openid email profile` (the name).
- PostgreSQL: a transaction advisory lock per lower-cased address (two-key form, class 46512020) serializes two first sign-ins of one
  person, so both end in the same login; a concurrent admin create with the same address is caught by the unique indexes (23505: refused,
  a retry signs in). Tested on both engines (differential) and under overlap.
- Unchanged: the domain check, the limiter (refusals only), the session, the password login.

### Additions 2026-10-27 (owner)
- `GOOGLE_ADMIN_EMAILS` (comma-separated, trimmed, lower-cased): a listed company address is made an admin when it signs in with Google
  (`accounts.makeAdmin`, both drivers; never demotes; logged `[google sign-in] made an admin by GOOGLE_ADMIN_EMAILS`). A refused sign-in
  (no_access, wrong domain) is not promoted. This is how the first admin of an environment gets in without a password.
- My profile: everyone edits their own name, department, job title, phone and building (`PUT /api/me` no longer admin-only; D-21
  revised; a building not sent is kept, a blank one clears it, as in People); email, role and status stay IT's. A login without a password (Google, an unused invite) sees "Set a password" with no current-password
  field (the route already skipped the check when there is no hash).

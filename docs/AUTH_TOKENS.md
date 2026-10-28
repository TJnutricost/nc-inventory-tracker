# Invitation and password-reset tokens

- **Storage:** `tokens.token` holds `sha256:<hex>` of the token in the emailed link, never the token itself (`src/tokenHash.js`; both drivers hash in `replaceToken` / `getToken`). A database copy or backup therefore contains no usable link. Tokens are 24 random bytes, so a plain SHA-256 is sufficient.
- **Unchanged:** expiry (invite 7 days, forgot 1 hour, checked by the route), one use (`completeReset` spends every token of the account), one live token per purpose, and the Google Workspace sign-in.
- **Outbox:** the recorded email body shows `#/reset/[redacted]`; the email actually sent is unchanged. Nothing logs a token.
- **Invite without email:** `POST /api/users/:id/invite` (admin only) returns the link when email is not configured **outside production** (local development). In production without email it answers 503 and issues no token.
- **Legacy tokens:** SQLite migration 20 and PostgreSQL migration 004 hash the tokens outstanding at deploy time in place, so links already emailed keep working until they expire or are used, and redact old outbox bodies. Re-running is safe (already-hashed values are skipped).
- **Rollback limitation:** after the migrations, older code cannot match the hashed rows: outstanding invite/reset links stop working and people need a new invitation (Invite button) or *Forgot password*. No data is lost.

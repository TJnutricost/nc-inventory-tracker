-- Reset / invitation tokens at rest (see SQLite migration 20, src/migrations.js, and src/tokenHash.js). tokens.token now holds
-- 'sha256:<hex>' of the link's secret. Outstanding tokens are converted in place with the same digest, so a link already emailed keeps
-- working until it expires or is used. Outbox bodies lose the token of every '#/reset/<token>' link ('[redacted]').
UPDATE tokens SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token NOT LIKE 'sha256:%';
UPDATE outbox SET body = regexp_replace(body, '(#/reset/)[A-Za-z0-9_-]+', '\1[redacted]', 'g') WHERE body LIKE '%#/reset/%';

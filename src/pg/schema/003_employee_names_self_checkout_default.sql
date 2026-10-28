-- Real first / last names and a safe self-checkout default (see SQLite migration 19, src/migrations.js). Additive: `name` stays, existing
-- rows keep first_name / last_name NULL (never split automatically) and keep their can_self_checkout; only the default for NEW rows changes.
ALTER TABLE employees ADD COLUMN first_name text COLLATE "C";
ALTER TABLE employees ADD COLUMN last_name text COLLATE "C";
ALTER TABLE employees ALTER COLUMN can_self_checkout SET DEFAULT 0;

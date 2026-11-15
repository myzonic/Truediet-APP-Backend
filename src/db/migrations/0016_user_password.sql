-- Custom email/password auth migration.
--
-- The custom auth flow (server/src/routes/auth.ts) stores the credential
-- hash on the user row itself, replacing the Better Auth convention of
-- keeping it inside the `account` table.
--
-- Existing rows are preserved: any legacy credential from the Better Auth
-- `account` table (provider_id = 'credential') is copied onto the user row
-- so current members can keep signing in while the migration is rolled out.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "password" text;

UPDATE "user" AS u
SET "password" = a."password"
FROM "account" AS a
WHERE a."user_id" = u."id"
  AND a."provider_id" = 'credential'
  AND a."password" IS NOT NULL;

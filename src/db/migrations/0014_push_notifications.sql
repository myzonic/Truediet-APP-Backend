-- Push notifications: device metadata, active flag and a delivery log.
--
-- Idempotent on purpose: the production database already has push_tokens, so
-- this migration must be safe to run against a schema that is already partly
-- up to date. No existing row is deleted and no column is dropped.

ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "device_id" text;
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now();
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp;
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp;
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "last_error" text;

CREATE INDEX IF NOT EXISTS "push_tokens_user_active_idx" ON "push_tokens" ("user_id", "is_active");

CREATE TABLE IF NOT EXISTS "notification_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "data" jsonb,
  "dedupe_key" text,
  "deliveries" integer NOT NULL DEFAULT 0,
  "tickets" jsonb,
  "receipt_checked_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notification_log_user_created_idx" ON "notification_log" ("user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "notification_log_user_dedupe_idx"
  ON "notification_log" ("user_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;

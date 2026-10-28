CREATE TABLE "preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"notifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accessibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consents" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
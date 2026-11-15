-- ResourceHub: categories, meal planning, grocery lists, worksheets,
-- checklists, templates and per-user resource progress.
-- All tables use IF NOT EXISTS / guarded constraints so re-running is safe and
-- existing production data is never touched.

CREATE TABLE IF NOT EXISTS "resource_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'book' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_categories_slug_unique" ON "resource_categories" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_categories_sort_idx" ON "resource_categories" USING btree ("sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"start_date" text,
	"duration_days" integer DEFAULT 7 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_plans_user_id_updated_idx" ON "meal_plans" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"day_index" integer NOT NULL,
	"meal_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"items" jsonb DEFAULT '[]' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_entries_plan_day_type_unique" ON "meal_plan_entries" USING btree ("plan_id","day_index","meal_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grocery_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grocery_lists_user_id_updated_idx" ON "grocery_lists" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grocery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Other' NOT NULL,
	"quantity" text DEFAULT '1' NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"notes" text,
	"purchased" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grocery_items_list_id_idx" ON "grocery_items" USING btree ("list_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worksheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worksheets_slug_unique" ON "worksheets" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worksheet_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"answers" jsonb DEFAULT '{}' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worksheet_responses_user_worksheet_unique" ON "worksheet_responses" USING btree ("user_id","worksheet_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"items" jsonb DEFAULT '[]' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklists_slug_unique" ON "checklists" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklist_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"checklist_id" uuid NOT NULL,
	"checked" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_progress_user_checklist_unique" ON "checklist_progress" USING btree ("user_id","checklist_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_templates_slug_unique" ON "resource_templates" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"content_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'resource' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_progress_user_slug_unique" ON "resource_progress" USING btree ("user_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_progress_user_id_last_viewed_idx" ON "resource_progress" USING btree ("user_id","last_viewed_at");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_plans_user_id_user_id_fk') THEN
    ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_plan_entries_plan_id_meal_plans_id_fk') THEN
    ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_plan_id_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grocery_lists_user_id_user_id_fk') THEN
    ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grocery_items_list_id_grocery_lists_id_fk') THEN
    ALTER TABLE "grocery_items" ADD CONSTRAINT "grocery_items_list_id_grocery_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."grocery_lists"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worksheet_responses_user_id_user_id_fk') THEN
    ALTER TABLE "worksheet_responses" ADD CONSTRAINT "worksheet_responses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worksheet_responses_worksheet_id_worksheets_id_fk') THEN
    ALTER TABLE "worksheet_responses" ADD CONSTRAINT "worksheet_responses_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_progress_user_id_user_id_fk') THEN
    ALTER TABLE "checklist_progress" ADD CONSTRAINT "checklist_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_progress_checklist_id_checklists_id_fk') THEN
    ALTER TABLE "checklist_progress" ADD CONSTRAINT "checklist_progress_checklist_id_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_progress_user_id_user_id_fk') THEN
    ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_progress_content_id_content_id_fk') THEN
    ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

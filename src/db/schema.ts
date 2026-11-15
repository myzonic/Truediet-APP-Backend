import { pgTable, text, timestamp, boolean, uuid, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

// ==========================================
// 1. Better Auth Core Authentication Schema
// ==========================================

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Hashed credential for email/password sign-in (scrypt via server/src/lib/password.ts).
  // Nullable so legacy Better Auth accounts that were Google-only or not yet
  // migrated keep their rows until a credential is set.
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
}, (t) => [
  index("session_user_id_idx").on(t.userId),
]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("account_user_id_idx").on(t.userId),
]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ==========================================
// 2. TrueDiet Nutrition & User Profile Schema
// ==========================================

export const profile = pgTable("profile", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  age: text("age"),
  sex: text("sex"),
  height: text("height"),
  weight: text("weight"),
  goal: text("goal"),
  allergies: jsonb("allergies").$type<string[]>().default([]),
  dietaryPreferences: jsonb("dietary_preferences").$type<string[]>().default([]),
  isAssessmentComplete: boolean("is_assessment_complete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Profile = typeof profile.$inferSelect;

// ==========================================
// 3. Content Library & Saved Items
// ==========================================

export const content = pgTable("content", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull(),
  category: text("category"),
  body: text("body"),
  mediaUrl: text("media_url"),
  listenUrl: text("listen_url"),
  durationMinutes: integer("duration_minutes"),
  episodeNumber: integer("episode_number"),
  startsAt: timestamp("starts_at"),
  isPremium: boolean("is_premium").notNull().default(false),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const savedItem = pgTable(
  "saved_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userContentUnique: uniqueIndex("saved_items_user_content_unique").on(t.userId, t.contentId),
  })
);

export type Content = typeof content.$inferSelect;
export type SavedItem = typeof savedItem.$inferSelect;

// ==========================================
// 4. Secure Messaging (Ask the Dietitian)
// ==========================================

export const messageThread = pgTable("message_threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  dietitianId: text("dietitian_id"),
  status: text("status").notNull().default("open"),
  lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("message_threads_user_id_idx").on(t.userId),
]);

export const message = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => messageThread.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(), // 'user' | 'dietitian'
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("messages_thread_id_idx").on(t.threadId),
]);

// ==========================================
// 5. Plans, Subscriptions & Entitlements
// ==========================================

export const plan = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  interval: text("interval").notNull(), // 'month' | 'year' | 'one_time'
  priceCents: integer("price_cents"),
  currency: text("currency"),
  providerProductId: text("provider_product_id"),
  features: jsonb("features").$type<string[]>().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const subscription = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => plan.id),
  status: text("status").notNull().default("free"), // free|active|trialing|past_due|canceled
  provider: text("provider"), // 'stripe' | 'revenuecat' | null
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const entitlement = pgTable(
  "entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userKeyUnique: uniqueIndex("entitlements_user_key_unique").on(t.userId, t.key),
  })
);

export type MessageThread = typeof messageThread.$inferSelect;
export type Message = typeof message.$inferSelect;
export type Plan = typeof plan.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
export type Entitlement = typeof entitlement.$inferSelect;

// ==========================================
// 6. User Preferences (notifications, accessibility, consents)
// ==========================================

export const preference = pgTable("preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  notifications: jsonb("notifications").$type<Record<string, boolean>>().notNull().default({}),
  accessibility: jsonb("accessibility").$type<Record<string, boolean>>().notNull().default({}),
  consents: jsonb("consents").$type<Record<string, boolean>>().notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Preference = typeof preference.$inferSelect;

// ==========================================
// 7. Tracking: meal logs & hunger check-ins
// ==========================================

export const mealLog = pgTable("meal_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  mealType: text("meal_type").notNull(), // 'breakfast' | 'lunch' | 'dinner' | 'snack'
  description: text("description").notNull(),
  notes: text("notes"),
  source: text("source").notNull().default("manual"), // 'manual' | 'voice'
  loggedAt: timestamp("logged_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("meal_logs_user_id_logged_at_idx").on(t.userId, t.loggedAt),
]);

export const hungerCheckin = pgTable("hunger_checkins", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  mealLogId: uuid("meal_log_id").references(() => mealLog.id, { onDelete: "set null" }),
  hungerBefore: integer("hunger_before"),
  fullnessAfter: integer("fullness_after"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("hunger_checkins_user_id_created_at_idx").on(t.userId, t.createdAt),
]);

export type MealLog = typeof mealLog.$inferSelect;
export type HungerCheckin = typeof hungerCheckin.$inferSelect;

// ==========================================
// 7b. Weight history - one row per logged weighing
// ==========================================

export const weightEntry = pgTable(
  "weight_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Stored exactly as typed (same shape as profile.weight, e.g. "72 kg");
    // validateWeight guarantees it starts with a parseable number.
    weight: text("weight").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("weight_entries_user_id_recorded_at_idx").on(t.userId, t.recordedAt),
  ]
);

export type WeightEntry = typeof weightEntry.$inferSelect;

// ==========================================
// 8. Push notification device tokens
// ==========================================

export const pushToken = pgTable("push_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  platform: text("platform").notNull().default("unknown"),
  // Stable per-install identifier from expo-application. Lets one device
  // replace its own token (Expo can reissue tokens) without touching the
  // member's other devices.
  deviceId: text("device_id"),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"),
  lastSuccessAt: timestamp("last_success_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("push_tokens_user_id_idx").on(t.userId),
  index("push_tokens_user_active_idx").on(t.userId, t.isActive),
]);

export type PushToken = typeof pushToken.$inferSelect;

// Every push the backend attempts, plus the Expo ticket ids needed to fetch
// receipts later. Also the dedupe ledger: a unique (user_id, dedupe_key) index
// stops the same event being delivered twice.
export const notificationLog = pgTable("notification_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  dedupeKey: text("dedupe_key"),
  deliveries: integer("deliveries").notNull().default(0),
  tickets: jsonb("tickets").$type<Array<{ token: string; ticketId?: string }>>(),
  receiptCheckedAt: timestamp("receipt_checked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("notification_log_user_created_idx").on(t.userId, t.createdAt),
]);

export type NotificationLog = typeof notificationLog.$inferSelect;

// ==========================================
// 9. Telehealth appointments
// ==========================================

export const appointment = pgTable("appointments", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  slot: text("slot").notNull(),
  isoStart: timestamp("iso_start"),
  visitType: text("visit_type").notNull().default("video"), // 'video' | 'phone'
  bookingId: text("booking_id"),
  meetingUrl: text("meeting_url"),
  callId: text("call_id"),
  status: text("status").notNull().default("requested"), // requested|confirmed|cancelled|completed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("appointments_user_id_created_at_idx").on(t.userId, t.createdAt),
  // The booking route looks appointments up by booking id on every insert;
  // without this it scans the whole table.
  index("appointments_booking_id_idx").on(t.bookingId),
]);

export type Appointment = typeof appointment.$inferSelect;

// ==========================================
// 10. Webinar / class registrations
// ==========================================

export const registration = pgTable(
  "registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("webinar"), // 'webinar' | 'class'
    registeredAt: timestamp("registered_at").notNull().defaultNow(),
  },
  (t) => ({
    registrationUserSlugUnique: uniqueIndex("registrations_user_slug_unique").on(t.userId, t.slug),
  })
);

export type Registration = typeof registration.$inferSelect;

// ==========================================
// 11. ResourceHub - categories, interactive tools, worksheets, checklists
// ==========================================

export const resourceCategory = pgTable("resource_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  icon: text("icon").notNull().default("book"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("resource_categories_sort_idx").on(t.sortOrder),
]);

export type ResourceCategory = typeof resourceCategory.$inferSelect;

// ---- Meal planning ----

export const mealPlan = pgTable("meal_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: text("start_date"),
  durationDays: integer("duration_days").notNull().default(7),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("meal_plans_user_id_updated_idx").on(t.userId, t.updatedAt),
]);

export const mealPlanEntry = pgTable(
  "meal_plan_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => mealPlan.id, { onDelete: "cascade" }),
    dayIndex: integer("day_index").notNull(),
    mealType: text("meal_type").notNull(), // breakfast | lunch | dinner | snack
    title: text("title").notNull(),
    description: text("description"),
    items: jsonb("items").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    mealPlanEntryUnique: uniqueIndex("meal_plan_entries_plan_day_type_unique").on(t.planId, t.dayIndex, t.mealType),
  })
);

export type MealPlan = typeof mealPlan.$inferSelect;
export type MealPlanEntry = typeof mealPlanEntry.$inferSelect;

// ---- Grocery lists ----

export const groceryList = pgTable("grocery_lists", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("grocery_lists_user_id_updated_idx").on(t.userId, t.updatedAt),
]);

export const groceryItem = pgTable(
  "grocery_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    listId: uuid("list_id")
      .notNull()
      .references(() => groceryList.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull().default("Other"),
    quantity: text("quantity").notNull().default("1"),
    unit: text("unit").notNull().default(""),
    notes: text("notes"),
    purchased: boolean("purchased").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("grocery_items_list_id_idx").on(t.listId),
  ]
);

export type GroceryList = typeof groceryList.$inferSelect;
export type GroceryItem = typeof groceryItem.$inferSelect;

// ---- Worksheets ----

export const worksheet = pgTable("worksheets", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  intro: text("intro").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  // Ordered list of fields: { key, label, type, placeholder?, options? }
  fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const worksheetResponse = pgTable(
  "worksheet_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    worksheetId: uuid("worksheet_id")
      .notNull()
      .references(() => worksheet.id, { onDelete: "cascade" }),
    answers: jsonb("answers").$type<Record<string, unknown>>().notNull().default({}),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    worksheetResponseUnique: uniqueIndex("worksheet_responses_user_worksheet_unique").on(t.userId, t.worksheetId),
  })
);

export type Worksheet = typeof worksheet.$inferSelect;
export type WorksheetResponse = typeof worksheetResponse.$inferSelect;

// ---- Checklists ----

export const checklist = pgTable("checklists", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  // Ordered list of checklist items: { key, label }
  items: jsonb("items").$type<Array<Record<string, unknown>>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const checklistProgress = pgTable(
  "checklist_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    checklistId: uuid("checklist_id")
      .notNull()
      .references(() => checklist.id, { onDelete: "cascade" }),
    // Map of item key -> boolean
    checked: jsonb("checked").$type<Record<string, boolean>>().notNull().default({}),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    checklistProgressUnique: uniqueIndex("checklist_progress_user_checklist_unique").on(t.userId, t.checklistId),
  })
);

export type Checklist = typeof checklist.$inferSelect;
export type ChecklistProgress = typeof checklistProgress.$inferSelect;

// ---- Templates ----

export const resourceTemplate = pgTable("resource_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  // Structured fields that define the template's editable areas.
  fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ResourceTemplate = typeof resourceTemplate.$inferSelect;

// ---- Resource progress (recently viewed / continue learning) ----

export const resourceProgress = pgTable(
  "resource_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    type: text("type").notNull().default("resource"),
    progress: integer("progress").notNull().default(0),
    lastViewedAt: timestamp("last_viewed_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    resourceProgressUnique: uniqueIndex("resource_progress_user_slug_unique").on(t.userId, t.slug),
    resourceProgressUserIdx: index("resource_progress_user_id_last_viewed_idx").on(t.userId, t.lastViewedAt),
  })
);

export type ResourceProgress = typeof resourceProgress.$inferSelect;

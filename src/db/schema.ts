import { pgTable, text, timestamp, boolean, uuid, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";

// ==========================================
// 1. Better Auth Core Authentication Schema
// ==========================================

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
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
});

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
});

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
});

export const message = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => messageThread.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(), // 'user' | 'dietitian'
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
});

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
});

export type MealLog = typeof mealLog.$inferSelect;
export type HungerCheckin = typeof hungerCheckin.$inferSelect;

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PushToken = typeof pushToken.$inferSelect;

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
});

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

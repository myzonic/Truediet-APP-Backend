# True Diet — production database runbook

Everything below is **read-only** unless a section explicitly says it writes.
Run the SQL in **pgAdmin** against the `TDDB` database on the Dokploy
PostgreSQL service (`true-diet-bwnpem:5432`).

The application never connects to PostgreSQL directly. The Expo app calls
`https://api.true-diet.com/api/*`; the backend connects to `TDDB` using the
`DATABASE_URL` configured in Dokploy.

---

## 1. Read-only: confirm the schema is present

```sql
-- Every table the app depends on. Expect 18 rows.
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN (
     'user','account','session','verification','profile',
     'content','saved_items','message_threads','messages',
     'plans','subscriptions','entitlements','preferences',
     'meal_logs','hunger_checkins','push_tokens',
     'appointments','registrations')
 ORDER BY table_name;
```

```sql
-- The drizzle migration journal. It lives in the `drizzle` schema, not in
-- `public`. One row per applied migration.
SELECT id, created_at, left(hash, 12) AS hash_prefix
  FROM drizzle.__drizzle_migrations
 ORDER BY created_at;
```

```sql
-- Column detail for any single table.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'meal_logs'
 ORDER BY ordinal_position;
```

```sql
-- Foreign keys and unique constraints.
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS references_table,
  ccu.column_name AS references_column,
  rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
 WHERE tc.constraint_type = 'FOREIGN KEY'
   AND tc.table_schema = 'public'
 ORDER BY tc.table_name, kcu.column_name;
```

---

## 2. Read-only: verify a test record was really saved

Run these right after using the app on a test account.

```sql
-- The signed-in test member and their profile.
SELECT u.id, u.email, u."created_at" AS account_created,
       p.goal, p.age, p.sex, p.height, p.weight,
       p.allergies, p.dietary_preferences, p."is_assessment_complete"
  FROM "user" u
  LEFT JOIN profile p ON p."user_id" = u.id
 WHERE u.email = 'your-test-email@example.com';
```

```sql
-- Saved articles, myths, recipes and resources.
SELECT s."created_at" AS saved_at, c.type, c.slug, c.title
  FROM saved_items s
  JOIN content c ON c.id = s."content_id"
  JOIN "user" u ON u.id = s."user_id"
 WHERE u.email = 'your-test-email@example.com'
 ORDER BY s."created_at" DESC;
```

```sql
-- Meal log and hunger check-in history.
SELECT m."logged_at", m."meal_type", m.description, m.source,
       h."hunger_before", h."fullness_after"
  FROM meal_logs m
  JOIN "user" u ON u.id = m."user_id"
  LEFT JOIN hunger_checkins h ON h."meal_log_id" = m.id
 WHERE u.email = 'your-test-email@example.com'
 ORDER BY m."logged_at" DESC;
```

```sql
-- Secure message thread and its messages.
SELECT t."created_at" AS thread_created, t.status,
       msg."created_at", msg."author_type", msg.body
  FROM message_threads t
  JOIN "user" u ON u.id = t."user_id"
  JOIN messages msg ON msg."thread_id" = t.id
 WHERE u.email = 'your-test-email@example.com'
 ORDER BY msg."created_at" ASC;
```

```sql
-- Notification, accessibility and consent preferences.
SELECT * FROM preferences p
  JOIN "user" u ON u.id = p."user_id"
 WHERE u.email = 'your-test-email@example.com';
```

```sql
-- Telehealth appointments and webinar registrations.
SELECT 'appointment' AS kind, a.slot, a."visit_type", a.status, a."booking_id", a."created_at"
  FROM appointments a JOIN "user" u ON u.id = a."user_id"
 WHERE u.email = 'your-test-email@example.com'
UNION ALL
SELECT 'registration', r.title, r.kind, NULL, NULL, r."registered_at"
  FROM registrations r JOIN "user" u ON u.id = r."user_id"
 WHERE u.email = 'your-test-email@example.com';
```

```sql
-- Registered push devices.
SELECT p.token, p.platform, p."created_at"
  FROM push_tokens p JOIN "user" u ON u.id = p."user_id"
 WHERE u.email = 'your-test-email@example.com';
```

```sql
-- The content library that the Learn, Resources and Podcasts tabs show.
SELECT type, count(*) AS rows
  FROM content
 GROUP BY type
 ORDER BY type;
```

```sql
-- Membership plans (prices are null until a payment provider is connected).
SELECT code, name, interval, "price_cents", currency, active FROM plans ORDER BY code;
```

---

## 3. The migration journal: what to check before deploying

The production database was created before the drizzle journal existed, so the
journal was empty. A plain `migrate()` would have re-run the first migration
and aborted with `42P07 relation "account" already exists`, leaving the other
eleven tables missing.

The server now handles this itself:

1. `server/src/db/baseline.ts` detects that the journal has no row while the
   original tables already exist.
2. It records the already-applied migration in the journal. **Nothing is
   dropped, altered or deleted** — only a bookkeeping row is inserted.
3. `migrate()` then applies only the migrations that are genuinely missing.
4. `0006_production_baseline` recreates any of the 0001–0005 tables that are
   still absent, using `CREATE TABLE IF NOT EXISTS` and guarded constraints,
   so it is safe to run repeatedly.

**Read-only check to confirm the journal state:**

```sql
SELECT count(*) AS journal_rows FROM drizzle.__drizzle_migrations;
```

| Result | Meaning | Action |
| --- | --- | --- |
| `journal_rows = 0` | Fresh, or created before the journal existed | Deploy as-is. The server baselines and migrates automatically. |
| `journal_rows >= 1` | Migrations were already recorded | Deploy as-is. The server resumes from the recorded point. |

**Do not run `drizzle-kit push` against production.** It is not part of the
deployment and can issue DDL that the reviewed migration files do not
contain.

---

## 4. Deployment steps

### 4.1 Before you deploy

- [ ] Take a backup of `TDDB` (Dokploy → the Postgres service → Backup, or
      `pg_dump` from pgAdmin's backup tool).
- [ ] Confirm the Dockerfile **build context is the `server/` directory**.
- [ ] Confirm the Dokploy environment variables are set on the backend
      service (names must match exactly):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | `postgresql://truediet:<password>@true-diet-bwnpem:5432/TDDB` |
| `BETTER_AUTH_SECRET` | Yes | Must be stable across restarts or sessions break. |
| `BETTER_AUTH_URL` | Yes | `https://api.true-diet.com` |
| `TRUSTED_ORIGINS` | Yes | Include the web app origin and `exp://*`, `truediet://*`. |
| `PORT` | Yes | `3000` |
| `NODE_ENV` | Recommended | `production` |
| `CAL_API_KEY`, `CAL_EVENT_TYPE_ID`, `CAL_USERNAME`, `CAL_API_URL` | Optional | Without them `GET /api/cal/config` reports `configured: false`. |
| `STREAM_API_KEY`, `STREAM_API_SECRET`, `STREAM_APP_ID`, `STREAM_DIETITIAN_USER_ID` | Optional | Without them the video endpoints return 503. |
| `EXPO_ACCESS_TOKEN` | Optional | Needed for the server to send push notifications. |
| `STRIPE_SECRET_KEY` | No | Not implemented. Leave unset — setting it flips the server into "payments configured" mode while the checkout route is still a stub. |

### 4.2 Deploy

1. Rebuild the backend image in Dokploy from the current source.
2. The container applies migrations on startup. Watch the startup log for:

   ```
   Checking and applying database migrations from /app/src/db/migrations...
   Baseline recorded: 0000_greedy_tempest (...) - existing tables were adopted without re-running migrations.
   Database migrations verified and up to date!
   Content library seed verified.
   Starting TrueDiet backend on port 3000...
   ```

   If the log shows `Migration error on startup:` the process now **exits
   instead of starting with a broken schema**. That is intentional — check the
   error message before restarting.

### 4.3 Post-deployment verification

```bash
# 1. Health (200 only when the connection works AND all 18 tables exist)
curl -s https://api.true-diet.com/health
# {"status":"ok","database":"connected","schema":"complete","tablesPresent":18}

# 2. Every route the app depends on
node server/scripts/route-check.mjs https://api.true-diet.com

# 3. End-to-end create / read / delete against production
VERIFY_BASE_URL=https://api.true-diet.com node server/scripts/db-verify.mjs
```

`db-verify.mjs` creates a throwaway account, exercises every feature, proves
that a second account cannot read or delete the first account's rows, and
deletes the test account at the end. It only touches its own test records.

### 4.4 Clean up the test records

The verification scripts delete their own accounts. To confirm nothing is
left behind:

```sql
-- Read-only: list any leftover test accounts
SELECT id, email, "created_at"
  FROM "user"
 WHERE email LIKE 'db-verify-%@truediet.test'
    OR email LIKE 'client-sync-%@truediet.test'
    OR email LIKE 'remote-check-%@truediet.test';
```

If any rows are listed, remove them explicitly (this deletes only the
throwaway test accounts and their cascaded rows):

```sql
DELETE FROM "user"
 WHERE email LIKE 'db-verify-%@truediet.test'
    OR email LIKE 'client-sync-%@truediet.test'
    OR email LIKE 'remote-check-%@truediet.test';
```

---

## 5. Feature → table mapping

| Feature | App screen | API endpoint | PostgreSQL table | User ownership | Save test | Read-back test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Registration / sign-in / sign-out | Welcome, AccountSetup, AuthScreen | `/api/auth/*` | `user`, `account`, `session`, `verification` | Better Auth | `db-verify.mjs` → auth sign-up | `GET /api/auth/get-session` | Connected |
| Nutrition profile | NutritionProfileSettings, AccountSetup | `POST /api/profile`, `GET /api/profile` | `profile` | `profile.user_id` → `user.id` (cascade) | profile upsert / update | profile read | Connected |
| Goals, age, sex, height, weight, allergies, dietary preferences | Goal, PersonalDetails, Allergies, DietaryPreferences | `POST /api/profile` | `profile` | as above | profile upsert | profile read | Connected |
| Meal logging | MealLog, BalancedMeal, VoiceFoodLog | `POST /api/meals`, `GET /api/meals` | `meal_logs` | `meal_logs.user_id` | meal log create | meal log list | Connected |
| Hunger check-ins | HungerFullness | `POST /api/hunger`, `GET /api/hunger` | `hunger_checkins` | `hunger_checkins.user_id` | hunger create | hunger list | Connected |
| Progress / history | Track, ProgressPatterns | `GET /api/progress` | `meal_logs`, `hunger_checkins` | both filtered by `user_id` | (reads the two tables above) | progress summary | Connected |
| Saved content | Article, MythDetail, RecipeDetail, ResourceDetail, SavedContent | `POST /api/saved`, `GET /api/saved`, `DELETE /api/saved/:id` | `saved_items` (+ `content`) | `saved_items.user_id` | saved item create | saved item list | Connected |
| Learn / articles | Learn, Topic, Article, Search | `GET /api/content`, `GET /api/content/:slug` | `content` | public library | seed | content list | Connected |
| Myths | Myths, MythDetail | `GET /api/content?type=myth` | `content` | public library | seed | content list | Connected |
| Recipes | Recipes, RecipeDetail | `GET /api/content?type=recipe` | `content` | public library | seed | content list | Connected |
| Resources / webinars / podcasts | Resources, Blog, Webinars, Podcast | `GET /api/content?type=...` | `content` | public library | seed | content list | Connected |
| Secure messaging | Dietitian, MessageDetail | `POST /api/messages`, `GET /api/messages/threads[/:id]` | `message_threads`, `messages` | `message_threads.user_id` | message send | message thread read | Connected |
| Preferences & consents | Settings, Privacy | `PUT /api/preferences`, `GET /api/preferences` | `preferences` | `preferences.user_id` (PK) | preferences save | preferences read | Connected |
| Plans | Packages | `GET /api/plans` | `plans` | public catalogue | seed | plans list | Connected |
| Subscription status | Subscription | `GET /api/subscription` | `subscriptions`, `entitlements` | `user_id` | (created by the payment webhook) | subscription read | Connected — no payment provider yet |
| Checkout | Checkout | `POST /api/subscription/checkout` | `plans` | `user_id` | 503 until a provider is configured | — | Stub, by design |
| Data export | Privacy | `GET /api/account/export` | all user tables | every query filtered by `user_id` | account export | export payload | Connected |
| Account deletion | Privacy | `DELETE /api/account` | `user` + cascade | session user only | account delete | cascade check | Connected |
| Push tokens | Notifications | `POST /api/push-tokens`, `GET`, `DELETE` | `push_tokens` | `push_tokens.user_id` | push token register | push token list | Connected |
| Telehealth booking | Telehealth | `POST /api/cal/bookings`, `POST /api/appointments` | `appointments` (+ Cal.com) | `appointments.user_id` | appointment create | appointment current | Connected |
| Video visit | AppointmentDetail, VideoCall | `POST /api/stream/call` | — (Stream holds the room) | session user | — | — | External service |
| Webinar registration | WebinarDetail | `POST /api/registrations`, `GET` | `registrations` | `registrations.user_id` | registration create | registration list | Connected |

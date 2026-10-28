/**
 * Verifies that the mobile client libraries talk to the real API and that the
 * data actually lands in Postgres. Mirrors the exact calls the app makes.
 *
 *   node scripts/client-sync-check.mjs
 *
 * Every check is scoped to the throwaway account created at the start, and
 * the account is deleted at the end.
 */
import pg from "pg";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";

const stamp = Date.now();
const tag = `sync-${stamp}`;
const email = `client-sync-${stamp}@truediet.test`;
const password = "VerifyPass123!";

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

let cookie = "";
let userId = null;
const results = [];

function pass(name, detail = "") {
  results.push({ ok: true, name });
  console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ ok: false, name, detail });
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8081",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const pair = setCookie.split(";")[0];
    if (pair && pair.includes("=")) cookie = cookie ? `${cookie}; ${pair}` : pair;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

console.log("\nClient-to-database sync verification");
console.log(`API : ${BASE}\n`);

// Sign up the way the app does.
{
  const { status, data } = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Client Sync", email, password },
  });
  userId = data?.user?.id || null;
  if ((status === 200 || status === 201) && userId) pass("app sign-up", `user ${userId}`);
  else {
    fail("app sign-up", `status ${status}`);
    await pool.end();
    process.exit(1);
  }
}

// src/lib/track.ts -> addMeal()
{
  const description = `client sync lunch ${tag}`;
  const { status } = await api("/api/meals", {
    method: "POST",
    body: { mealType: "lunch", description, notes: "n", source: "manual" },
  });
  const n = await count("select count(*)::int as n from meal_logs where user_id = $1 and description = $2", [
    userId,
    description,
  ]);
  if (status === 201 && n === 1) pass("addMeal() -> meal_logs", "row persisted");
  else fail("addMeal() -> meal_logs", `status ${status} rows=${n}`);
}

// src/lib/track.ts -> addCheckin()
{
  const note = `client sync checkin ${tag}`;
  const { status } = await api("/api/hunger", {
    method: "POST",
    body: { hungerBefore: 2, fullnessAfter: 4, note },
  });
  const n = await count("select count(*)::int as n from hunger_checkins where user_id = $1 and note = $2", [
    userId,
    note,
  ]);
  if (status === 201 && n === 1) pass("addCheckin() -> hunger_checkins", "row persisted");
  else fail("addCheckin() -> hunger_checkins", `status ${status} rows=${n}`);
}

// src/lib/track.ts -> loadProgress()
{
  const { status, data } = await api("/api/progress");
  const weekMeals = data?.week?.meals ?? 0;
  if (status === 200 && weekMeals >= 1) pass("loadProgress()", `week meals=${weekMeals}`);
  else fail("loadProgress()", `status ${status} weekMeals=${weekMeals}`);
}

// src/lib/content.ts -> saveContent() for an app-only article id.
{
  const contentId = `nb-client-${stamp}`;
  const { status } = await api("/api/saved", {
    method: "POST",
    body: {
      contentId,
      title: `Client sync article ${tag}`,
      subtitle: "Evidence-based article - 5 min",
      type: "article",
    },
  });
  const n = await count(
    "select count(*)::int as n from saved_items s join content c on c.id = s.content_id where s.user_id = $1 and c.slug = $2",
    [userId, contentId]
  );
  if (status === 201 && n === 1) pass("saveContent() -> saved_items", "row persisted");
  else fail("saveContent() -> saved_items", `status ${status} rows=${n}`);

  const list = await api("/api/saved");
  const found = (list.data?.items || []).some((i) => i.id === contentId);
  if (list.status === 200 && found) pass("loadSavedContent()", "client id round-trips");
  else fail("loadSavedContent()", `status ${list.status} found=${found}`);

  const del = await api(`/api/saved/${contentId}`, { method: "DELETE" });
  const n2 = await count(
    "select count(*)::int as n from saved_items s join content c on c.id = s.content_id where s.user_id = $1 and c.slug = $2",
    [userId, contentId]
  );
  if (del.status === 200 && n2 === 0) pass("unsaveContent()", "row removed");
  else fail("unsaveContent()", `status ${del.status} rows=${n2}`);
}

// src/lib/messages.ts -> sendMessage()
{
  const body = `client sync question ${tag}`;
  const { status } = await api("/api/messages", { method: "POST", body: { body } });
  const n = await count(
    "select count(*)::int as n from messages m join message_threads t on t.id = m.thread_id where t.user_id = $1 and m.body = $2",
    [userId, body]
  );
  if (status === 201 && n === 1) pass("sendMessage() -> messages", "row persisted");
  else fail("sendMessage() -> messages", `status ${status} rows=${n}`);
}

// src/lib/preferences.ts -> savePreferences()
{
  const { status } = await api("/api/preferences", {
    method: "PUT",
    body: { notifications: { push: true, messages: false } },
  });
  const n = await count(
    "select count(*)::int as n from preferences where user_id = $1 and notifications->>'messages' = 'false'",
    [userId]
  );
  if (status === 200 && n === 1) pass("savePreferences() -> preferences", "row persisted");
  else fail("savePreferences() -> preferences", `status ${status} rows=${n}`);
}

// src/lib/profile.ts -> saveProfile()
{
  const goal = `goal-${tag}`;
  const { status } = await api("/api/profile", {
    method: "POST",
    body: { goal, age: "30", dietaryPreferences: ["gluten free"] },
  });
  const n = await count("select count(*)::int as n from profile where user_id = $1 and goal = $2", [
    userId,
    goal,
  ]);
  if (status === 201 && n === 1) pass("saveProfile() -> profile", "row persisted");
  else fail("saveProfile() -> profile", `status ${status} rows=${n}`);
}

// src/lib/subscription.ts -> loadPlans()
{
  const { status, data } = await api("/api/plans");
  const n = await count("select count(*)::int as n from plans where active = true");
  if (status === 200 && (data?.plans || []).length === n && n > 0)
    pass("loadPlans() -> plans", `${n} active plan(s)`);
  else fail("loadPlans() -> plans", `status ${status} api=${(data?.plans || []).length} db=${n}`);
}

// src/lib/content.ts -> loadContent()
{
  const { status, data } = await api("/api/content?limit=100");
  const n = await count("select count(*)::int as n from content");
  if (status === 200 && (data?.items || []).length === n)
    pass("loadContent() -> content", `${n} row(s)`);
  else fail("loadContent() -> content", `status ${status} api=${(data?.items || []).length} db=${n}`);
}

// src/lib/appointments.ts -> saveAppointment()
{
  const slot = `sync slot ${tag}`;
  const { status } = await api("/api/appointments", {
    method: "POST",
    body: {
      slot,
      visitType: "video",
      isoStart: new Date(Date.now() + 86400000).toISOString(),
      bookingId: `sync-${stamp}`,
    },
  });
  const n = await count("select count(*)::int as n from appointments where user_id = $1 and slot = $2", [
    userId,
    slot,
  ]);
  if (status === 201 && n === 1) pass("saveAppointment() -> appointments", "row persisted");
  else fail("saveAppointment() -> appointments", `status ${status} rows=${n}`);

  const current = await api("/api/appointments/current");
  if (current.status === 200 && current.data?.appointment?.slot === slot)
    pass("loadAppointment()", "current appointment returned");
  else fail("loadAppointment()", `status ${current.status} slot=${current.data?.appointment?.slot}`);
}

// src/lib/registrations.ts -> registerForSession()
{
  const slug = `sync-webinar-${stamp}`;
  const { status } = await api("/api/registrations", {
    method: "POST",
    body: { title: `Sync Webinar ${tag}`, slug, kind: "webinar" },
  });
  const n = await count("select count(*)::int as n from registrations where user_id = $1 and slug = $2", [
    userId,
    slug,
  ]);
  if (status === 201 && n === 1) pass("registerForSession() -> registrations", "row persisted");
  else fail("registerForSession() -> registrations", `status ${status} rows=${n}`);
}

// src/lib/notifications.ts -> push token registration
{
  const token = `ExponentPushToken[client-sync-${stamp}]`;
  const { status } = await api("/api/push-tokens", {
    method: "POST",
    body: { token, platform: "android" },
  });
  const n = await count("select count(*)::int as n from push_tokens where user_id = $1 and token = $2", [
    userId,
    token,
  ]);
  if (status === 201 && n === 1) pass("push token register -> push_tokens", "row persisted");
  else fail("push token register -> push_tokens", `status ${status} rows=${n}`);
}

// src/lib/account.ts -> exportAccountData()
{
  const { status, data } = await api("/api/account/export");
  const hasMeals = Array.isArray(data?.mealLogs);
  const hasCheckins = Array.isArray(data?.hungerCheckins);
  if (status === 200 && hasMeals && hasCheckins)
    pass("exportAccountData()", "includes meals and check-ins");
  else fail("exportAccountData()", `status ${status} meals=${hasMeals} checkins=${hasCheckins}`);
}

// Cleanup
{
  const del = await api("/api/account", { method: "DELETE" });
  const userRows = await count('select count(*)::int as n from "user" where id = $1', [userId]);
  const leftovers = await count(
    `select (
       (select count(*) from profile where user_id = $1) +
       (select count(*) from meal_logs where user_id = $1) +
       (select count(*) from hunger_checkins where user_id = $1) +
       (select count(*) from saved_items where user_id = $1) +
       (select count(*) from message_threads where user_id = $1) +
       (select count(*) from preferences where user_id = $1) +
       (select count(*) from push_tokens where user_id = $1)
     )::int as n`,
    [userId]
  );
  if (del.status === 200 && userRows === 0 && leftovers === 0)
    pass("account delete", "user + all owned rows removed");
  else fail("account delete", `status ${del.status} user=${userRows} leftover=${leftovers}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
await pool.end();
process.exit(failed.length ? 1 : 0);

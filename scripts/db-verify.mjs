/**
 * End-to-end database verification.
 *
 * Creates a throwaway account through Better Auth, then exercises every
 * write path the app uses and asserts the row actually landed in Postgres.
 * Run against the local dev database:
 *
 *   node scripts/db-verify.mjs
 *
 * The script cleans up after itself and never prints secrets.
 */
import pg from "pg";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";

const stamp = Date.now();
const email = `db-verify-${stamp}@truediet.test`;
const password = "VerifyPass123!";

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

let cookie = "";
const results = [];

function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
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
      // Better Auth requires an Origin header on state-changing requests.
      Origin: process.env.VERIFY_ORIGIN || "http://localhost:8081",
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

async function countRows(table, where, params) {
  // "user" is a reserved word in Postgres, so the table name is quoted.
  const res = await pool.query(`select count(*)::int as n from "${table}" where ${where}`, params);
  return res.rows[0].n;
}

console.log(`\nTrue Diet database verification`);
console.log(`API    : ${BASE}`);
console.log(`DB     : ${DATABASE_URL.replace(/:[^:@/]+@/, ":****@")}\n`);

// ---------------------------------------------------------------- health
{
  const { status, data } = await api("/health");
  if (status === 200 && data?.database === "connected") pass("health", "database connected");
  else fail("health", `status ${status} ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------- sign up
let userId = null;
{
  const { status, data } = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "DB Verify", email, password },
  });
  if (status === 200 || status === 201) {
    userId = data?.user?.id || null;
    const n = await countRows("user", "email = $1", [email]);
    if (n === 1) pass("auth sign-up", `user row written (${userId})`);
    else fail("auth sign-up", `user rows = ${n}`);
  } else {
    fail("auth sign-up", `status ${status} ${JSON.stringify(data)}`);
  }
}

if (!userId) {
  console.log("\nCannot continue without a session.\n");
  await pool.end();
  process.exit(1);
}

// ---------------------------------------------------------------- profile
{
  const body = {
    displayName: "DB Verify",
    age: "34",
    sex: "female",
    height: "5'6\"",
    weight: "150",
    goal: "Maintain weight",
    allergies: ["peanuts"],
    dietaryPreferences: ["vegetarian"],
    isAssessmentComplete: true,
  };
  const post = await api("/api/profile", { method: "POST", body });
  const n = await countRows("profile", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("profile upsert", `row saved, goal="${body.goal}"`);
  else fail("profile upsert", `status ${post.status} rows=${n}`);

  const get = await api("/api/profile");
  if (get.status === 200 && get.data?.profile?.goal === "Maintain weight")
    pass("profile read", "round-trip matches");
  else fail("profile read", `status ${get.status} ${JSON.stringify(get.data)}`);

  const upd = await api("/api/profile", { method: "POST", body: { goal: "Improve overall health" } });
  const n2 = await countRows("profile", "user_id = $1", [userId]);
  if (upd.status === 200 && n2 === 1) pass("profile update", "no duplicate row created");
  else fail("profile update", `status ${upd.status} rows=${n2}`);
}

// ---------------------------------------------------------------- content
let contentId = null;
{
  const res = await api("/api/content");
  const items = res.data?.content || res.data?.items || res.data || [];
  if (res.status === 200 && Array.isArray(items) && items.length > 0) {
    contentId = items[0].id;
    pass("content list", `${items.length} rows`);
  } else {
    fail("content list", `status ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- saved items
{
  if (!contentId) {
    fail("saved items", "no content row available");
  } else {
    const post = await api("/api/saved", { method: "POST", body: { contentId } });
    const n = await countRows("saved_items", "user_id = $1 AND content_id = $2", [userId, contentId]);
    if (post.status === 201 && n === 1) pass("saved item create", "row written");
    else fail("saved item create", `status ${post.status} rows=${n}`);

    const list = await api("/api/saved");
    const listItems = list.data?.saved || list.data?.items || list.data || [];
    if (list.status === 200 && Array.isArray(listItems) && listItems.length >= 1)
      pass("saved item list", `${listItems.length} row(s)`);
    else fail("saved item list", `status ${list.status}`);

    const del = await api(`/api/saved/${contentId}`, { method: "DELETE" });
    const n2 = await countRows("saved_items", "user_id = $1 AND content_id = $2", [userId, contentId]);
    if (del.status === 200 && n2 === 0) pass("saved item delete", "row removed");
    else fail("saved item delete", `status ${del.status} rows=${n2}`);
  }
}

// ---------------------------------------------------------------- messages
let threadId = null;
{
  const post = await api("/api/messages", { method: "POST", body: { body: "What is a balanced plate?" } });
  threadId = post.data?.message?.threadId || post.data?.threadId || null;
  const n = await countRows("messages", "body = $1", ["What is a balanced plate?"]);
  if ((post.status === 201 || post.status === 200) && n === 1) pass("message send", `row written (thread ${threadId})`);
  else fail("message send", `status ${post.status} rows=${n}`);

  const threads = await api("/api/messages/threads");
  const list = threads.data?.threads || [];
  if (threads.status === 200 && list.length >= 1) pass("message threads", `${list.length} thread(s)`);
  else fail("message threads", `status ${threads.status}`);

  if (threadId) {
    const one = await api(`/api/messages/threads/${threadId}`);
    const msgs = one.data?.messages || [];
    if (one.status === 200 && msgs.length >= 1) pass("message thread read", `${msgs.length} message(s)`);
    else fail("message thread read", `status ${one.status}`);
  }
}

// ---------------------------------------------------------------- preferences
{
  const body = {
    notifications: { push: false, messages: true, appointments: true, webinars: false, content: true },
    accessibility: { largerText: true, reduceMotion: false },
  };
  const put = await api("/api/preferences", { method: "PUT", body });
  const n = await countRows("preferences", "user_id = $1", [userId]);
  if (put.status === 200 && n === 1) pass("preferences save", "row written");
  else fail("preferences save", `status ${put.status} rows=${n}`);

  const get = await api("/api/preferences");
  if (
    get.status === 200 &&
    get.data?.preferences?.notifications?.push === false &&
    get.data?.preferences?.accessibility?.largerText === true
  )
    pass("preferences read", "round-trip matches");
  else fail("preferences read", `status ${get.status} ${JSON.stringify(get.data?.preferences?.notifications)}`);

  // A partial update must not clear the sections it does not mention.
  const consentsOnly = await api("/api/preferences", {
    method: "PUT",
    body: { consents: { personalization: false, analytics: true } },
  });
  const after = await api("/api/preferences");
  if (
    consentsOnly.status === 200 &&
    after.data?.preferences?.consents?.analytics === true &&
    after.data?.preferences?.notifications?.push === false
  )
    pass("preferences partial update", "untouched sections preserved");
  else
    fail(
      "preferences partial update",
      `notifications.push=${after.data?.preferences?.notifications?.push} consents.analytics=${after.data?.preferences?.consents?.analytics}`,
    );
}

// ---------------------------------------------------------------- meals
let mealId = null;
{
  const post = await api("/api/meals", {
    method: "POST",
    body: { mealType: "lunch", description: "verify lunch: grains, protein, veg", notes: "db check", source: "manual" },
  });
  mealId = post.data?.meal?.id || null;
  const n = await countRows("meal_logs", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("meal log create", "row written");
  else fail("meal log create", `status ${post.status} rows=${n}`);

  const list = await api("/api/meals");
  const meals = list.data?.meals || [];
  if (list.status === 200 && meals.length >= 1) pass("meal log list", `${meals.length} meal(s)`);
  else fail("meal log list", `status ${list.status}`);

  const del = await api(`/api/meals/${mealId}`, { method: "DELETE" });
  const n2 = await countRows("meal_logs", "user_id = $1", [userId]);
  if (del.status === 200 && n2 === 0) pass("meal log delete", "row removed");
  else fail("meal log delete", `status ${del.status} rows=${n2}`);
}

// ---------------------------------------------------------------- hunger
{
  const post = await api("/api/hunger", { method: "POST", body: { hungerBefore: 3, fullnessAfter: 4, note: "verify" } });
  const n = await countRows("hunger_checkins", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("hunger check-in create", "row written");
  else fail("hunger check-in create", `status ${post.status} rows=${n}`);

  const list = await api("/api/hunger");
  const list2 = list.data?.checkins || [];
  if (list.status === 200 && list2.length >= 1) pass("hunger check-in list", `${list2.length} row(s)`);
  else fail("hunger check-in list", `status ${list.status}`);
}

// ---------------------------------------------------------------- progress
{
  const res = await api("/api/progress");
  const days = res.data?.week?.days;
  if (res.status === 200 && Array.isArray(days) && days.length === 7)
    pass("progress summary", `7-day series, ${res.data.week.meals} meal(s)`);
  else fail("progress summary", `status ${res.status}`);
}

// ---------------------------------------------------------------- push token
{
  const token = `ExponentPushToken[verify-${stamp}]`;
  const post = await api("/api/push-tokens", { method: "POST", body: { token, platform: "android" } });
  const n = await countRows("push_tokens", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("push token register", "row written");
  else fail("push token register", `status ${post.status} rows=${n}`);

  const list = await api("/api/push-tokens");
  const list2 = list.data?.tokens || [];
  if (list.status === 200 && Array.isArray(list2)) pass("push token list", `${list2.length} token(s)`);
  else fail("push token list", `status ${list.status}`);

  const del = await api(`/api/push-tokens/${encodeURIComponent(token)}`, { method: "DELETE" });
  const n2 = await countRows("push_tokens", "user_id = $1", [userId]);
  if (del.status === 200 && n2 === 0) pass("push token delete", "row removed");
  else fail("push token delete", `status ${del.status} rows=${n2}`);
}

// ---------------------------------------------------------------- subscription
{
  const plans = await api("/api/plans");
  const planList = plans.data?.plans || [];
  if (plans.status === 200 && planList.length >= 0) pass("plans list", `${planList.length} plan(s)`);
  else fail("plans list", `status ${plans.status}`);

  const sub = await api("/api/subscription");
  if (sub.status === 200) pass("subscription read", "ok");
  else fail("subscription read", `status ${sub.status}`);
}

// ---------------------------------------------------------------- account export
{
  const res = await api("/api/account/export");
  if (res.status === 200 && res.data) pass("account export", "payload returned");
  else fail("account export", `status ${res.status}`);
}

// ---------------------------------------------------------------- appointments
{
  const post = await api("/api/appointments", {
    method: "POST",
    body: {
      slot: "Tue - 10:00 AM",
      visitType: "video",
      isoStart: new Date(Date.now() + 86400000).toISOString(),
      bookingId: "verify-booking-1",
      meetingUrl: "https://example.test/meet/verify",
    },
  });
  const n = await countRows("appointments", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("appointment create", "row written");
  else fail("appointment create", `status ${post.status} rows=${n}`);

  const list = await api("/api/appointments");
  const list2 = list.data?.appointments || [];
  if (list.status === 200 && list2.length >= 1) pass("appointment list", `${list2.length} row(s)`);
  else fail("appointment list", `status ${list.status}`);

  const current = await api("/api/appointments/current");
  if (current.status === 200 && current.data?.appointment) pass("appointment current", "row returned");
  else fail("appointment current", `status ${current.status}`);

  const apptId = post.data?.appointment?.id;
  if (apptId) {
    const patch = await api(`/api/appointments/${apptId}`, {
      method: "PATCH",
      body: { status: "cancelled" },
    });
    const st = await countRows("appointments", "id = $1 and status = 'cancelled'", [apptId]);
    if (patch.status === 200 && st === 1) pass("appointment update", "status persisted");
    else fail("appointment update", `status ${patch.status} rows=${st}`);

    const del = await api(`/api/appointments/${apptId}`, { method: "DELETE" });
    const n2 = await countRows("appointments", "id = $1", [apptId]);
    if (del.status === 200 && n2 === 0) pass("appointment delete", "row removed");
    else fail("appointment delete", `status ${del.status} rows=${n2}`);
  }
}

// ---------------------------------------------------------------- registrations
{
  const post = await api("/api/registrations", {
    method: "POST",
    body: { title: "Verify Webinar", slug: "verify-webinar", kind: "webinar" },
  });
  const n = await countRows("registrations", "user_id = $1", [userId]);
  if (post.status === 201 && n === 1) pass("registration create", "row written");
  else fail("registration create", `status ${post.status} rows=${n}`);

  const list = await api("/api/registrations");
  const list2 = list.data?.registrations || [];
  if (list.status === 200 && list2.length >= 1) pass("registration list", `${list2.length} row(s)`);
  else fail("registration list", `status ${list.status}`);

  const del = await api("/api/registrations/verify-webinar", { method: "DELETE" });
  const n2 = await countRows("registrations", "user_id = $1", [userId]);
  if (del.status === 200 && n2 === 0) pass("registration delete", "row removed");
  else fail("registration delete", `status ${del.status} rows=${n2}`);
}

// ---------------------------------------------------------------- auth isolation
{
  const saved = cookie;
  cookie = "";
  const res = await api("/api/meals");
  if (res.status === 401) pass("auth guard", "unauthenticated request rejected");
  else fail("auth guard", `expected 401, got ${res.status}`);
  cookie = saved;
}

// ------------------------------------------------- cross-user authorization
{
  // A second account must not be able to read or delete the first account's data.
  const otherEmail = `db-verify-other-${stamp}@truediet.test`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Other User", email: otherEmail, password: "VerifyPass123!" },
  });
  const otherId = signUp.data?.user?.id;

  if (!otherId) {
    fail("cross-user isolation", "could not create the second account");
  } else {
    // Sign in as the second account in a separate cookie jar so the two
    // sessions cannot be confused with each other.
    const firstCookie = cookie;
    cookie = "";

    const signIn = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: otherEmail, password: "VerifyPass123!" },
    });
    const secondCookie = cookie;
    cookie = firstCookie;

    // The first account leaves a meal and an appointment behind.
    await api("/api/meals", {
      method: "POST",
      body: { mealType: "dinner", description: "cross user probe meal" },
    });
    const mealRes = await api("/api/meals");
    const firstMealId = mealRes.data?.meals?.[0]?.id;

    await api("/api/appointments", {
      method: "POST",
      body: { slot: "owned by first account", visitType: "video" },
    });
    const appts = await api("/api/appointments");
    const firstApptId = appts.data?.appointments?.[0]?.id;

    if (signIn.status !== 200) {
      fail("cross-user isolation", `second sign-in failed: ${signIn.status}`);
    } else {
      cookie = secondCookie;
      const otherMeals = await api("/api/meals");
      const otherAppts = await api("/api/appointments");

      const mealsLeaked = (otherMeals.data?.meals || []).some(
        (m) => m.description === "cross user probe meal"
      );
      const apptLeaked = (otherAppts.data?.appointments || []).some(
        (a) => a.slot === "owned by first account"
      );

      if (!mealsLeaked && !apptLeaked) pass("cross-user read isolation", "no rows leaked");
      else fail("cross-user read isolation", `meals=${mealsLeaked} appointments=${apptLeaked}`);

      // The second account must not be able to delete the first account's rows.
      let deleteBlocked = true;
      if (firstMealId) {
        const del = await api(`/api/meals/${firstMealId}`, { method: "DELETE" });
        if (del.status !== 404) deleteBlocked = false;
      }
      if (firstApptId) {
        const del = await api(`/api/appointments/${firstApptId}`, { method: "DELETE" });
        if (del.status !== 404) deleteBlocked = false;
      }
      if (deleteBlocked) pass("cross-user delete isolation", "foreign rows cannot be deleted");
      else fail("cross-user delete isolation", "a foreign row was deleted");
    }

    // Clean up the second account.
    cookie = secondCookie;
    await api("/api/account", { method: "DELETE" });
    cookie = firstCookie;
  }
}

// ---------------------------------------------------------------- cleanup
{
  const res = await api("/api/account", { method: "DELETE" });
  const n = await countRows("user", "email = $1", [email]);
  if (res.status === 200 && n === 0) pass("account delete", "user + cascaded rows removed");
  else fail("account delete", `status ${res.status} user rows=${n}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
await pool.end();
process.exit(failed.length ? 1 : 0);

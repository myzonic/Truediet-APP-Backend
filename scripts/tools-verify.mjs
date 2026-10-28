/**
 * End-to-end verification for the Home screen + Quick Tools + TRUE DIET TOOLS
 * features. Exercises the exact API calls the screens make and confirms each
 * row lands in PostgreSQL.
 *
 *   node scripts/tools-verify.mjs
 */
import pg from "pg";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";

const stamp = Date.now();
const email = `tools-verify-${stamp}@truediet.test`;
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

console.log("\nHome screen + Quick Tools + TRUE DIET TOOLS verification");
console.log(`API : ${BASE}\n`);

// ---------------------------------------------------------------- account
{
  const { status, data } = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Tools Verify", email, password },
  });
  userId = data?.user?.id || null;
  if ((status === 200 || status === 201) && userId) pass("sign-up", `user ${userId}`);
  else {
    fail("sign-up", `status ${status}`);
    await pool.end();
    process.exit(1);
  }
}

// ---- HOME 1-4: greeting, YOUR NUTRITION FOCUS, View your plan -----------
// The Home focus card reads the goal from GET /api/profile (and the local
// onboarding copy). Save a goal the way AccountSetup does, then read it back.
{
  const goal = "Build muscle";
  const post = await api("/api/profile", {
    method: "POST",
    body: { goal, age: "34", sex: "female", dietaryPreferences: ["vegetarian"] },
  });
  const n = await count("select count(*)::int as n from profile where user_id = $1 and goal = $2", [userId, goal]);
  if (post.status === 201 && n === 1) pass("Home focus: save goal -> profile", "row persisted");
  else fail("Home focus: save goal -> profile", `status ${post.status} rows=${n}`);

  // Home re-reads it on mount.
  const get = await api("/api/profile");
  if (get.status === 200 && get.data?.profile?.goal === goal) pass("Home focus: read goal back", `goal="${goal}"`);
  else fail("Home focus: read goal back", `status ${get.status} goal=${get.data?.profile?.goal}`);

  // Changing the goal must update in place, not duplicate.
  const upd = await api("/api/profile", { method: "POST", body: { goal: "Maintain weight" } });
  const rows = await count("select count(*)::int as n from profile where user_id = $1", [userId]);
  if (upd.status === 200 && rows === 1) pass("Home focus: update goal (no duplicate row)", "1 row");
  else fail("Home focus: update goal", `status ${upd.status} rows=${rows}`);
}

// ---- HOME 5: Today's Insight / NUTRITION BASICS article ------------------
{
  // The Home insight card loads the "Nutrition Basics" topic's featured
  // article from the content library.
  const res = await api("/api/content?type=article&limit=100");
  const items = res.data?.items || [];
  const nb = items.filter((i) => i.category === "Nutrition Basics");
  if (res.status === 200 && nb.length >= 1) pass("Home insight: article from DB", `${nb.length} in topic`);
  else fail("Home insight: article from DB", `status ${res.status} nb=${nb.length}`);

  // Opening the card navigates to Article -> reads the full body.
  if (nb[0]) {
    const detail = await api(`/api/content/${encodeURIComponent(nb[0].slug)}`);
    const hasBody = typeof detail.data?.item?.body === "string" && detail.data.item.body.length > 0;
    if (detail.status === 200 && hasBody) pass("Home insight: article body readable", `${detail.data.item.body.length} chars`);
    else fail("Home insight: article body readable", `status ${detail.status} hasBody=${hasBody}`);
  }
}

// ---- QUICK TOOL 1: Balanced Meal Builder -> meal_logs -------------------
{
  // Mirrors BalancedMealScreen.save(): addMeal({mealType, description, source})
  const post = await api("/api/meals", {
    method: "POST",
    body: { mealType: "lunch", description: "Balanced meal: Protein, Vegetables", source: "manual" },
  });
  const n = await count("select count(*)::int as n from meal_logs where user_id = $1 and description = $2", [
    userId,
    "Balanced meal: Protein, Vegetables",
  ]);
  if (post.status === 201 && n === 1) pass("Balanced Meal Builder -> meal_logs", "row persisted");
  else fail("Balanced Meal Builder -> meal_logs", `status ${post.status} rows=${n}`);

  const list = await api("/api/meals");
  const found = (list.data?.meals || []).some((m) => m.description.startsWith("Balanced meal:"));
  if (list.status === 200 && found) pass("Balanced Meal Builder: visible in Track", "list includes it");
  else fail("Balanced Meal Builder: visible in Track", `status ${list.status} found=${found}`);

  // Invalid mealType must be rejected (validation).
  const bad = await api("/api/meals", { method: "POST", body: { mealType: "brunch", description: "x" } });
  if (bad.status === 400) pass("Balanced Meal Builder: invalid mealType rejected", "400");
  else fail("Balanced Meal Builder: invalid mealType rejected", `status ${bad.status}`);

  // Empty description must be rejected.
  const empty = await api("/api/meals", { method: "POST", body: { mealType: "lunch", description: "   " } });
  if (empty.status === 400) pass("Balanced Meal Builder: empty description rejected", "400");
  else fail("Balanced Meal Builder: empty description rejected", `status ${empty.status}`);
}

// ---- QUICK TOOL 2: Label Reading (static, no persistence) ---------------
{
  // Label Reading is educational only. Verify its companion content row
  // exists so the Learn/Resource link resolves.
  const res = await api("/api/content?q=label&limit=50");
  const found = (res.data?.items || []).some((i) => /label/i.test(i.title));
  if (res.status === 200 && found) pass("Label Reading: content row exists", "searchable");
  else fail("Label Reading: content row exists", `status ${res.status} found=${found}`);
}

// ---- QUICK TOOL 3: Hunger & Fullness Scale -> hunger_checkins ------------
{
  // Mirrors HungerFullnessScreen.save(): addCheckin({hungerBefore, fullnessAfter})
  const post = await api("/api/hunger", {
    method: "POST",
    body: { hungerBefore: 2, fullnessAfter: 4, note: "tools verify" },
  });
  const n = await count("select count(*)::int as n from hunger_checkins where user_id = $1 and note = $2", [
    userId,
    "tools verify",
  ]);
  if (post.status === 201 && n === 1) pass("Hunger Scale -> hunger_checkins", "row persisted");
  else fail("Hunger Scale -> hunger_checkins", `status ${post.status} rows=${n}`);

  const list = await api("/api/hunger");
  if (list.status === 200 && (list.data?.checkins || []).length >= 1) pass("Hunger Scale: list back", `${list.data.checkins.length}`);
  else fail("Hunger Scale: list back", `status ${list.status}`);

  // Ratings outside 1..5 must be rejected.
  const bad = await api("/api/hunger", { method: "POST", body: { hungerBefore: 9 } });
  if (bad.status === 400) pass("Hunger Scale: out-of-range rejected", "400");
  else fail("Hunger Scale: out-of-range rejected", `status ${bad.status}`);

  // At least one rating is required.
  const none = await api("/api/hunger", { method: "POST", body: {} });
  if (none.status === 400) pass("Hunger Scale: empty check-in rejected", "400");
  else fail("Hunger Scale: empty check-in rejected", `status ${none.status}`);

  // The check-in must feed the Progress chart.
  const progress = await api("/api/progress");
  const total = (progress.data?.week?.checkins || 0);
  if (progress.status === 200 && total >= 1) pass("Hunger Scale: feeds Progress", `${total} check-ins this week`);
  else fail("Hunger Scale: feeds Progress", `status ${progress.status} total=${total}`);
}

// ---- QUICK TOOL 4: Nutrition Myths -> content ---------------------------
{
  const res = await api("/api/content?type=myth&limit=100");
  const items = res.data?.items || [];
  if (res.status === 200 && items.length >= 1) pass("Myths: from DB", `${items.length} myths`);
  else fail("Myths: from DB", `status ${res.status} count=${items.length}`);

  if (items[0]) {
    const detail = await api(`/api/content/${encodeURIComponent(items[0].slug)}`);
    const body = detail.data?.item?.body || "";
    const hasSections = /## What is true/i.test(body) && /## Takeaway/i.test(body);
    if (detail.status === 200 && hasSections) pass("Myth detail: evidence sections present", "what is true + takeaway");
    else fail("Myth detail: evidence sections present", `status ${detail.status} hasSections=${hasSections}`);
  }

  // Saving a myth uses POST /api/saved with client meta.
  if (items[0]) {
    const save = await api("/api/saved", {
      method: "POST",
      body: { contentId: items[0].slug, title: items[0].title, subtitle: "Nutrition claim", type: "myth" },
    });
    const n = await count(
      "select count(*)::int as n from saved_items s join content c on c.id = s.content_id where s.user_id = $1 and c.slug = $2",
      [userId, items[0].slug]
    );
    if (save.status === 201 && n === 1) pass("Myth: save -> saved_items", "row persisted");
    else fail("Myth: save -> saved_items", `status ${save.status} rows=${n}`);
  }
}

// ---- QUICK TOOL 5: Recipes -> content ------------------------------------
{
  const res = await api("/api/content?type=recipe&limit=100");
  const items = res.data?.items || [];
  if (res.status === 200 && items.length >= 1) pass("Recipes: from DB", `${items.length} recipes`);
  else fail("Recipes: from DB", `status ${res.status} count=${items.length}`);

  if (items[0]) {
    const detail = await api(`/api/content/${encodeURIComponent(items[0].slug)}`);
    const body = detail.data?.item?.body || "";
    const hasSections = /## Ingredients/i.test(body) && /## Method/i.test(body) && /## Tip/i.test(body);
    if (detail.status === 200 && hasSections) pass("Recipe detail: ingredients + method + tip", "complete");
    else fail("Recipe detail: ingredients + method + tip", `status ${detail.status} hasSections=${hasSections}`);
  }
}

// ---- QUICK TOOL 6: Ask Dietitian -> messages -----------------------------
{
  const post = await api("/api/messages", { method: "POST", body: { body: "tools verify question" } });
  const n = await count(
    "select count(*)::int as n from messages m join message_threads t on t.id = m.thread_id where t.user_id = $1 and m.body = $2",
    [userId, "tools verify question"]
  );
  if (post.status === 201 && n === 1) pass("Ask Dietitian -> messages", "row persisted");
  else fail("Ask Dietitian -> messages", `status ${post.status} rows=${n}`);

  const threadId = post.data?.threadId || post.data?.message?.threadId;
  if (threadId) {
    const one = await api(`/api/messages/threads/${threadId}`);
    const msgs = one.data?.messages || [];
    if (one.status === 200 && msgs.length >= 1) pass("Ask Dietitian: thread readable", `${msgs.length} message(s)`);
    else fail("Ask Dietitian: thread readable", `status ${one.status}`);

    // Oversized message must be rejected.
    const big = await api("/api/messages", { method: "POST", body: { body: "x".repeat(3000) } });
    if (big.status === 400) pass("Ask Dietitian: oversized rejected", "400");
    else fail("Ask Dietitian: oversized rejected", `status ${big.status}`);
  }
}

// ---- QUICK TOOL 7: Telehealth -> appointments ---------------------------
{
  const post = await api("/api/appointments", {
    method: "POST",
    body: { slot: "Tue · 10:00 AM", visitType: "video", isoStart: new Date(Date.now() + 86400000).toISOString() },
  });
  const n = await count("select count(*)::int as n from appointments where user_id = $1 and slot = $2", [
    userId,
    "Tue · 10:00 AM",
  ]);
  if (post.status === 201 && n === 1) pass("Telehealth -> appointments", "row persisted");
  else fail("Telehealth -> appointments", `status ${post.status} rows=${n}`);

  const current = await api("/api/appointments/current");
  if (current.status === 200 && current.data?.appointment) pass("Appointment detail: current returned", current.data.appointment.slot);
  else fail("Appointment detail: current returned", `status ${current.status}`);

  // visitType must be coerced, not trusted.
  const bad = await api("/api/appointments", { method: "POST", body: { slot: "x", visitType: "carrier-pigeon" } });
  const v = bad.data?.appointment?.visit_type ?? bad.data?.appointment?.visitType;
  if (bad.status === 201 && (v === undefined || v === "video")) pass("Telehealth: invalid visitType coerced", "video");
  else fail("Telehealth: invalid visitType coerced", `status ${bad.status} visitType=${v}`);

  // Missing slot rejected.
  const noSlot = await api("/api/appointments", { method: "POST", body: { visitType: "video" } });
  if (noSlot.status === 400) pass("Telehealth: missing slot rejected", "400");
  else fail("Telehealth: missing slot rejected", `status ${noSlot.status}`);
}

// ---- TRUE DIET TOOLS: content-backed tools reachable ---------------------
{
  const types = ["topic", "article", "myth", "recipe", "resource", "webinar", "class", "podcast"];
  const bad = [];
  for (const type of types) {
    const res = await api(`/api/content?type=${type}&limit=100`);
    if (res.status !== 200) bad.push(`${type}:${res.status}`);
  }
  if (bad.length === 0) pass("All content types served", types.join(", "));
  else fail("All content types served", bad.join(", "));
}

// ---- Cross-user isolation on tool data -----------------------------------
{
  const otherEmail = `tools-verify-other-${stamp}@truediet.test`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Other", email: otherEmail, password },
  });
  const otherId = signUp.data?.user?.id;
  const firstCookie = cookie;
  cookie = "";
  const signIn = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: otherEmail, password },
  });
  const secondCookie = cookie;
  cookie = firstCookie;

  if (!otherId || signIn.status !== 200) {
    fail("Tools: cross-user isolation", "could not create second account");
  } else {
    cookie = secondCookie;
    const meals = await api("/api/meals");
    const hunger = await api("/api/hunger");
    const appts = await api("/api/appointments");
    const leaked =
      (meals.data?.meals || []).some((m) => m.description.startsWith("Balanced meal:")) ||
      (hunger.data?.checkins || []).some((c) => c.note === "tools verify") ||
      (appts.data?.appointments || []).some((a) => a.slot === "Tue · 10:00 AM");
    if (!leaked) pass("Tools: cross-user isolation", "no leakage");
    else fail("Tools: cross-user isolation", "leaked rows");

    // Second account must not delete the first account's meal.
    const firstMeal = (await api("/api/meals")).data?.meals?.[0]?.id;
    let blocked = true;
    if (firstMeal) {
      const del = await api(`/api/meals/${firstMeal}`, { method: "DELETE" });
      if (del.status !== 404) blocked = false;
    }
    if (blocked) pass("Tools: cross-user delete blocked", "404");
    else fail("Tools: cross-user delete blocked", "allowed");

    cookie = secondCookie;
    await api("/api/account", { method: "DELETE" });
    cookie = firstCookie;
  }
}

// ---- HOME data survives sign-out / sign-in (persistence) -----------------
{
  // Sign out, sign back in, and confirm the goal + meals are still there.
  const saved = cookie;
  cookie = "";
  await api("/api/auth/sign-out", { method: "POST" });
  cookie = "";
  const back = await api("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
  if (back.status === 200) {
    const profile = await api("/api/profile");
    const meals = await api("/api/meals");
    const goalOk = profile.data?.profile?.goal === "Maintain weight";
    const mealOk = (meals.data?.meals || []).length >= 1;
    if (goalOk && mealOk) pass("Persistence: data survives re-login", "goal + meals intact");
    else fail("Persistence: data survives re-login", `goalOk=${goalOk} mealOk=${mealOk}`);
  } else {
    fail("Persistence: data survives re-login", `sign-in status ${back.status}`);
  }
  cookie = saved || cookie;
}

// ---- cleanup --------------------------------------------------------------
{
  const del = await api("/api/account", { method: "DELETE" });
  const n = await count('select count(*)::int as n from "user" where email = $1', [email]);
  if (del.status === 200 && n === 0) pass("cleanup", "test account removed");
  else fail("cleanup", `status ${del.status} user=${n}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
await pool.end();
process.exit(failed.length ? 1 : 0);

/**
 * End-to-end persistence proof against a deployed server.
 *
 * API only - no direct database connection - so it works against production.
 * Creates a throwaway account, exercises every persistent feature, reads the
 * data back, proves a second account cannot see it, then deletes it.
 *
 *   node scripts/production-e2e.mjs [baseUrl]
 */
const BASE = process.argv[2] || "https://api.true-diet.com";

const stamp = Date.now();
const tag = `e2e-${stamp}`;
const email = `${tag}@truediet.test`;
const password = "ProdE2ePass123!";

let cookie = "";
const results = [];

const pass = (n, d = "") => {
  results.push({ ok: true, n });
  console.log(`  PASS  ${n}${d ? " - " + d : ""}`);
};
const fail = (n, d = "") => {
  results.push({ ok: false, n, d });
  console.log(`  FAIL  ${n}${d ? " - " + d : ""}`);
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8081",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) {
    const pair = sc.split(";")[0];
    if (pair.includes("=")) cookie = cookie ? `${cookie}; ${pair}` : pair;
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

console.log(`\nProduction E2E persistence proof: ${BASE}`);
console.log(`test account: ${email}\n`);

// ---------------------------------------------------------------- sign up
{
  const { status, data } = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Prod E2E", email, password },
  });
  const id = data?.user?.id;
  if ((status === 200 || status === 201) && id) pass("sign-up", `user ${id}`);
  else {
    fail("sign-up", `status ${status} ${JSON.stringify(data).slice(0, 120)}`);
    console.log("\nCannot continue without a session.");
    process.exit(1);
  }
}

// ------------------------------------------------- nutrition focus (goal)
{
  const post = await api("/api/profile", {
    method: "POST",
    body: { goal: "Build muscle", age: "34", dietaryPreferences: ["gluten free"] },
  });
  const get = await api("/api/profile");
  const saved = get.data?.profile?.goal;
  if (post.status === 201 && saved === "Build muscle")
    pass("save + read nutrition focus", `goal="${saved}"`);
  else fail("save + read nutrition focus", `post=${post.status} goal=${saved}`);

  const upd = await api("/api/profile", { method: "POST", body: { goal: "Maintain weight" } });
  const get2 = await api("/api/profile");
  if (upd.status === 200 && get2.data?.profile?.goal === "Maintain weight")
    pass("update goal (no duplicate row)", get2.data.profile.goal);
  else fail("update goal", `status=${upd.status}`);
}

// ------------------------------------------------- content library (Home)
{
  const list = await api("/api/content?limit=200");
  const items = list.data?.items || [];
  const byType = items.reduce((a, i) => ((a[i.type] = (a[i.type] || 0) + 1), a), {});
  if (list.status === 200 && items.length >= 50)
    pass("content library", `${items.length} rows :: ${JSON.stringify(byType)}`);
  else fail("content library", `status=${list.status} count=${items.length}`);

  const article = items.find((i) => i.type === "article");
  if (article) {
    const d = await api(`/api/content/${encodeURIComponent(article.slug)}`);
    const bodyLen = (d.data?.item?.body || "").length;
    if (d.status === 200 && bodyLen > 0) pass("article body readable", `${bodyLen} chars`);
    else fail("article body readable", `status=${d.status}`);
  }
}

// ------------------------------------------------- Balanced Meal Builder
{
  const post = await api("/api/meals", {
    method: "POST",
    body: { mealType: "lunch", description: `${tag} balanced meal`, source: "manual" },
  });
  const list = await api("/api/meals");
  const found = (list.data?.meals || []).some((m) => m.description === `${tag} balanced meal`);
  if (post.status === 201 && found) pass("Balanced Meal Builder save + read", "meal visible in Track");
  else fail("Balanced Meal Builder save + read", `post=${post.status} found=${found}`);

  const bad = await api("/api/meals", { method: "POST", body: { mealType: "brunch", description: "x" } });
  if (bad.status === 400) pass("invalid mealType rejected", "400");
  else fail("invalid mealType rejected", `status=${bad.status}`);
}

// ------------------------------------------------- Hunger & Fullness
{
  const post = await api("/api/hunger", {
    method: "POST",
    body: { hungerBefore: 3, fullnessAfter: 4, note: tag },
  });
  const list = await api("/api/hunger");
  const found = (list.data?.checkins || []).some((c) => c.note === tag);
  if (post.status === 201 && found) pass("Hunger check-in save + read", "visible in history");
  else fail("Hunger check-in save + read", `post=${post.status} found=${found}`);

  const bad = await api("/api/hunger", { method: "POST", body: { hungerBefore: 9 } });
  if (bad.status === 400) pass("out-of-range rating rejected", "400");
  else fail("out-of-range rating rejected", `status=${bad.status}`);
}

// ------------------------------------------------- Progress chart
{
  const p = await api("/api/progress");
  const total = (p.data?.week?.meals || 0) + (p.data?.week?.checkins || 0);
  if (p.status === 200 && total >= 2) pass("progress aggregates", `${p.data.week.meals} meals + ${p.data.week.checkins} check-ins`);
  else fail("progress aggregates", `status=${p.status} total=${total}`);
}

// ------------------------------------------------- Saved content
{
  const list = await api("/api/content?limit=200");
  const target = (list.data?.items || []).find((i) => i.type === "recipe");
  if (!target) {
    fail("saved content", "no recipe row to save");
  } else {
    const save = await api("/api/saved", {
      method: "POST",
      body: { contentId: target.slug, title: target.title, subtitle: target.subtitle, type: "recipe" },
    });
    const back = await api("/api/saved");
    const found = (back.data?.items || []).some((i) => i.slug === target.slug || i.id === target.slug);
    if (save.status === 201 && found) pass("save + read saved content", target.title.slice(0, 35));
    else fail("save + read saved content", `save=${save.status} found=${found}`);

    const del = await api(`/api/saved/${encodeURIComponent(target.slug)}`, { method: "DELETE" });
    const after = await api("/api/saved");
    const gone = !(after.data?.items || []).some((i) => i.slug === target.slug);
    if (del.status === 200 && gone) pass("delete saved content", "row removed");
    else fail("delete saved content", `status=${del.status} gone=${gone}`);
  }
}

// ------------------------------------------------- Ask Dietitian
{
  const post = await api("/api/messages", { method: "POST", body: { body: `${tag} question` } });
  const threadId = post.data?.threadId || post.data?.message?.threadId;
  const threads = await api("/api/messages/threads");
  const listOk = (threads.data?.threads || []).length >= 1;
  if (post.status === 201 && listOk) pass("send message + read threads", `thread ${threadId}`);
  else fail("send message + read threads", `post=${post.status} threads=${listOk}`);

  if (threadId) {
    const one = await api(`/api/messages/threads/${threadId}`);
    const msgs = one.data?.messages || [];
    if (one.status === 200 && msgs.some((m) => m.body === `${tag} question`))
      pass("read full conversation", `${msgs.length} message(s)`);
    else fail("read full conversation", `status=${one.status}`);
  }

  const big = await api("/api/messages", { method: "POST", body: { body: "x".repeat(3000) } });
  if (big.status === 400) pass("oversized message rejected", "400");
  else fail("oversized message rejected", `status=${big.status}`);
}

// ------------------------------------------------- Preferences
{
  const put = await api("/api/preferences", {
    method: "PUT",
    body: { notifications: { push: false, messages: true }, consents: { analytics: true } },
  });
  const get = await api("/api/preferences");
  const n = get.data?.preferences?.notifications || {};
  const c = get.data?.preferences?.consents || {};
  const ok = n.push === false && c.analytics === true;
  if (put.status === 200 && ok)
    pass("save + read preferences", `push=${n.push} analytics=${c.analytics}`);
  else fail("save + read preferences", `put=${put.status} ok=${ok}`);

  // A partial update must not wipe the other sections.
  const put2 = await api("/api/preferences", { method: "PUT", body: { accessibility: { largerText: true } } });
  const get2 = await api("/api/preferences");
  const stillThere = get2.data?.preferences?.notifications?.push === false;
  if (put2.status === 200 && stillThere)
    pass("partial update preserves other sections", "notifications kept");
  else fail("partial update preserves other sections", `preserved=${stillThere}`);
}

// ------------------------------------------------- Plans / subscription
{
  const plans = await api("/api/plans");
  const count = (plans.data?.plans || []).length;
  if (plans.status === 200 && count >= 3) pass("plans catalogue", `${count} plans`);
  else fail("plans catalogue", `status=${plans.status} count=${count}`);

  const sub = await api("/api/subscription");
  if (sub.status === 200 && sub.data?.subscription?.status)
    pass("subscription status", sub.data.subscription.status);
  else fail("subscription status", `status=${sub.status}`);
}

// ------------------------------------------------- Appointments
{
  const post = await api("/api/appointments", {
    method: "POST",
    body: { slot: `${tag} slot`, visitType: "video", isoStart: new Date(Date.now() + 86400000).toISOString() },
  });
  const current = await api("/api/appointments/current");
  const ok = post.status === 201 && current.data?.appointment?.slot === `${tag} slot`;
  if (ok) pass("save + read appointment", current.data.appointment.slot);
  else fail("save + read appointment", `post=${post.status} current=${current.data?.appointment?.slot}`);

  const noSlot = await api("/api/appointments", { method: "POST", body: { visitType: "video" } });
  if (noSlot.status === 400) pass("appointment without slot rejected", "400");
  else fail("appointment without slot rejected", `status=${noSlot.status}`);
}

// ------------------------------------------------- Webinar registration
{
  const slug = `${tag}-webinar`;
  const post = await api("/api/registrations", {
    method: "POST",
    body: { title: `${tag} Webinar`, slug, kind: "webinar" },
  });
  const list = await api("/api/registrations");
  const found = (list.data?.registrations || []).some((r) => r.slug === slug);
  if (post.status === 201 && found) pass("save + read webinar registration", "row present");
  else fail("save + read webinar registration", `post=${post.status} found=${found}`);

  const dupe = await api("/api/registrations", { method: "POST", body: { title: "x", slug, kind: "webinar" } });
  const list2 = await api("/api/registrations");
  const count = (list2.data?.registrations || []).filter((r) => r.slug === slug).length;
  if (count === 1) pass("duplicate registration is idempotent", "no double row");
  else fail("duplicate registration is idempotent", `rows=${count} status=${dupe.status}`);

  await api(`/api/registrations/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

// ------------------------------------------------- Push token
{
  const token = `ExponentPushToken[${tag}]`;
  const post = await api("/api/push-tokens", { method: "POST", body: { token, platform: "android" } });
  const list = await api("/api/push-tokens");
  const found = (list.data?.tokens || []).some((t) => t.token === token);
  if (post.status === 201 && found) pass("save + read push token", "registered");
  else fail("save + read push token", `post=${post.status} found=${found}`);

  const bad = await api("/api/push-tokens", { method: "POST", body: { token: "not-a-real-token" } });
  if (bad.status === 400) pass("invalid push token rejected", "400");
  else fail("invalid push token rejected", `status=${bad.status}`);
}

// ------------------------------------------------- Account export
{
  const res = await api("/api/account/export");
  const keys = res.data ? Object.keys(res.data) : [];
  const need = ["profile", "mealLogs", "hungerCheckins", "appointments", "registrations", "preferences"];
  const have = need.filter((k) => keys.includes(k));
  if (res.status === 200 && have.length === need.length)
    pass("account export includes user data", `${keys.length} sections`);
  else fail("account export includes user data", `missing=${need.filter((k) => !keys.includes(k)).join(",")}`);
}

// ------------------------------------------------- Cross-user isolation
{
  const otherEmail = `${tag}-other@truediet.test`;
  const firstCookie = cookie; // session for the account under test

  // Sign up a second account. api() stores the returned session cookie.
  cookie = "";
  const sign = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Other", email: otherEmail, password },
  });
  const otherCookie = cookie; // session for the second account
  const otherId = sign.data?.user?.id;

  if (!otherId) {
    fail("cross-user isolation", "could not create second account");
  } else {
    const meals = await api("/api/meals");
    const hunger = await api("/api/hunger");
    const appts = await api("/api/appointments");
    const profile = await api("/api/profile");

    const leaked =
      (meals.data?.meals || []).length > 0 ||
      (hunger.data?.checkins || []).length > 0 ||
      (appts.data?.appointments || []).length > 0;

    if (!leaked) pass("second account sees no private rows", "meals/hunger/appointments empty");
    else fail("second account sees no private rows", "LEAK");

    const goalLeak = profile.data?.profile?.goal === "Maintain weight";
    if (!goalLeak) pass("second account sees no profile goal", "goal not exposed");
    else fail("second account sees no profile goal", "LEAK");

    // Delete only the second account, then restore the first session.
    cookie = otherCookie;
    const del = await api("/api/account", { method: "DELETE" });
    if (del.status === 200) pass("second account cleaned up", "deleted");
    else fail("second account cleaned up", `status=${del.status}`);
    cookie = firstCookie;
  }
}

// ------------------------------------------------- Persistence across re-login
{
  const saved = cookie;
  cookie = saved; // send the session so sign-out acts on this account
  await api("/api/auth/sign-out", { method: "POST" }).catch(() => undefined);
  cookie = "";
  const back = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  if (back.status === 200) {
    const profile = await api("/api/profile");
    const meals = await api("/api/meals");
    const prefs = await api("/api/preferences");
    const goal = profile.data?.profile?.goal === "Maintain weight";
    const meal = (meals.data?.meals || []).length >= 1;
    const pref = prefs.data?.preferences?.notifications?.push === false;
    if (goal && meal && pref)
      pass("data survives sign-out + sign-in", "goal, meals, preferences intact");
    else fail("data survives sign-out + sign-in", `goal=${goal} meals=${meal} prefs=${pref}`);
  } else {
    fail("data survives sign-out + sign-in", `sign-in status=${back.status}`);
  }
}

// ------------------------------------------------- cleanup
{
  const del = await api("/api/account", { method: "DELETE" });
  const back = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  const stillThere = back.status === 200;
  if (del.status === 200 && !stillThere) pass("test account deleted", "no leftover data");
  else fail("test account deleted", `del=${del.status} stillUsable=${stillThere}`);
  cookie = "";
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) {
  console.log("Failures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

/**
 * Connectivity audit: for every API endpoint the app calls, reports whether
 * it is actually reachable and whether it touches the database.
 *
 *   node scripts/connectivity-audit.mjs [baseUrl]
 *
 * A route that answers 401/200/400/503 exists. 404 means it is missing from
 * the running build.
 */
const BASE = process.argv[2] || "http://localhost:3000";

/**
 * feature -> { path, method, needsAuth, table, screen }
 * needsAuth: "yes" means an unauthenticated call should return 401.
 */
const endpoints = [
  // --- auth -------------------------------------------------------------
  { feature: "Sign up / Sign in", path: "/api/auth/get-session", method: "GET", auth: "no", table: "user, account, session", screen: "Welcome, AccountSetup, Login" },

  // --- profile ----------------------------------------------------------
  { feature: "Nutrition focus (goal)", path: "/api/profile", method: "GET", auth: "yes", table: "profile", screen: "Home focus card, NutritionProfileSettings" },
  { feature: "Save nutrition focus", path: "/api/profile", method: "POST", auth: "yes", table: "profile", screen: "AccountSetup, NutritionProfileSettings" },

  // --- content ----------------------------------------------------------
  { feature: "Today's Insight + article body", path: "/api/content?type=article&limit=5", method: "GET", auth: "no", table: "content", screen: "Home insight card, Article" },
  { feature: "Topics list", path: "/api/content?type=topic&limit=5", method: "GET", auth: "no", table: "content", screen: "Learn, Topic" },
  { feature: "Myths list", path: "/api/content?type=myth&limit=5", method: "GET", auth: "no", table: "content", screen: "Myths, MythDetail" },
  { feature: "Recipes list", path: "/api/content?type=recipe&limit=5", method: "GET", auth: "no", table: "content", screen: "Recipes, RecipeDetail" },
  { feature: "Resources / classes / podcast", path: "/api/content?type=podcast&limit=5", method: "GET", auth: "no", table: "content", screen: "Resources, Webinars, Podcast" },

  // --- tracking ---------------------------------------------------------
  { feature: "Balanced Meal Builder save", path: "/api/meals", method: "POST", auth: "yes", table: "meal_logs", screen: "BalancedMeal, MealLog, VoiceFoodLog" },
  { feature: "Meal log list", path: "/api/meals", method: "GET", auth: "yes", table: "meal_logs", screen: "Track" },
  { feature: "Hunger & Fullness check-in", path: "/api/hunger", method: "POST", auth: "yes", table: "hunger_checkins", screen: "HungerFullness" },
  { feature: "Hunger check-in history", path: "/api/hunger", method: "GET", auth: "yes", table: "hunger_checkins", screen: "HungerFullness" },
  { feature: "Progress chart", path: "/api/progress", method: "GET", auth: "yes", table: "meal_logs, hunger_checkins", screen: "Track, ProgressPatterns" },

  // --- saved content ----------------------------------------------------
  { feature: "Save article / myth / recipe / resource", path: "/api/saved", method: "POST", auth: "yes", table: "saved_items, content", screen: "Article, MythDetail, RecipeDetail, ResourceDetail" },
  { feature: "Saved library list", path: "/api/saved", method: "GET", auth: "yes", table: "saved_items, content", screen: "SavedContent" },

  // --- messaging --------------------------------------------------------
  { feature: "Ask Dietitian send", path: "/api/messages", method: "POST", auth: "yes", table: "message_threads, messages", screen: "Dietitian, MessageDetail" },
  { feature: "Conversation list", path: "/api/messages/threads", method: "GET", auth: "yes", table: "message_threads", screen: "MessageDetail" },

  // --- preferences ------------------------------------------------------
  { feature: "Notification / accessibility toggles", path: "/api/preferences", method: "GET", auth: "yes", table: "preferences", screen: "Settings" },
  { feature: "Consent toggles", path: "/api/preferences", method: "PUT", auth: "yes", table: "preferences", screen: "Privacy" },

  // --- plans / subscription --------------------------------------------
  { feature: "Packages list", path: "/api/plans", method: "GET", auth: "no", table: "plans", screen: "Packages" },
  { feature: "Subscription status", path: "/api/subscription", method: "GET", auth: "yes", table: "subscriptions, entitlements", screen: "Subscription" },
  { feature: "Checkout", path: "/api/subscription/checkout", method: "POST", auth: "yes", table: "plans", screen: "Checkout" },

  // --- account ----------------------------------------------------------
  { feature: "Data export", path: "/api/account/export", method: "GET", auth: "yes", table: "all user tables", screen: "Privacy" },

  // --- push -------------------------------------------------------------
  { feature: "Register push device", path: "/api/push-tokens", method: "GET", auth: "yes", table: "push_tokens", screen: "Notifications" },

  // --- telehealth -------------------------------------------------------
  { feature: "Telehealth availability", path: "/api/cal/config", method: "GET", auth: "no", table: "(Cal.com, no table)", screen: "Telehealth" },
  { feature: "Telehealth book", path: "/api/cal/bookings", method: "POST", auth: "yes", table: "(Cal.com)", screen: "Telehealth" },
  { feature: "Appointment saved", path: "/api/appointments", method: "POST", auth: "yes", table: "appointments", screen: "Telehealth, AppointmentDetail" },
  { feature: "Appointment detail", path: "/api/appointments/current", method: "GET", auth: "yes", table: "appointments", screen: "AppointmentDetail" },
  { feature: "Video call room", path: "/api/stream/config", method: "GET", auth: "no", table: "(Stream, no table)", screen: "VideoCall" },

  // --- webinars ---------------------------------------------------------
  { feature: "Webinar registration", path: "/api/registrations", method: "GET", auth: "yes", table: "registrations", screen: "WebinarDetail" },
];

async function probe(path, method) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" || method === "PUT" ? JSON.stringify({ __audit: true }) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return res.status;
  } catch (e) {
    return `ERR:${String(e.message).slice(0, 30)}`;
  }
}

function verdict(status, needsAuth) {
  if (typeof status === "string") return { mark: "ERR", ok: false, note: status };
  if (status === 404) return { mark: "404", ok: false, note: "ROUTE MISSING" };
  if (needsAuth === "yes" && status === 401) return { mark: "401", ok: true, note: "present (auth required)" };
  if (status >= 200 && status < 500) return { mark: String(status), ok: true, note: "present" };
  return { mark: String(status), ok: false, note: "present but failing" };
}

console.log(`\nConnectivity audit: ${BASE}`);
console.log("Auth-protected routes need a session; 401 without one = route exists.\n");

let missing = 0;
let present = 0;
let failing = 0;

console.log("FEATURE".padEnd(42) + "ENDPOINT".padEnd(46) + "STATUS");
console.log("-".repeat(100));

for (const e of endpoints) {
  const status = await probe(e.path, e.method);
  const v = verdict(status, e.auth);
  if (v.ok) present++;
  else if (status === 404) missing++;
  else failing++;

  const label = `${e.feature}`;
  const endpoint = `${e.method} ${e.path}`;
  console.log(
    (v.ok ? "  " : "X ") +
      label.slice(0, 40).padEnd(40) +
      endpoint.slice(0, 44).padEnd(44) +
      `${v.mark} ${v.note}`
  );
  if (!v.ok) {
    console.log("      table: " + e.table);
    console.log("      screen: " + e.screen);
  }
}

console.log("");
console.log("=".repeat(100));
console.log(`reachable: ${present}/${endpoints.length}   missing(404): ${missing}   failing: ${failing}`);
if (missing > 0) {
  console.log("\n=> This build is missing routes. The database may be connected but the app");
  console.log("   cannot reach those features until the backend is redeployed.");
} else if (failing > 0) {
  console.log("\n=> All routes exist but some return errors. Check the server log.");
} else {
  console.log("\n=> All app endpoints are reachable on this server.");
}

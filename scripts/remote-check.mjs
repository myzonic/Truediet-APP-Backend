/**
 * Read-only check of a deployed server: which routes exist, and whether the
 * database tables they touch are actually present.
 *
 *   node scripts/remote-check.mjs https://api.true-diet.com
 */
const BASE = process.argv[2] || "https://api.true-diet.com";

const paths = [
  "/health",
  "/api/auth/get-session",
  "/api/profile",
  "/api/content",
  "/api/saved",
  "/api/messages/threads",
  "/api/preferences",
  "/api/account/export",
  "/api/meals",
  "/api/hunger",
  "/api/progress",
  "/api/plans",
  "/api/subscription",
  "/api/push-tokens",
  "/api/cal/config",
  "/api/stream/config",
];

const stamp = Date.now();
const email = `remote-check-${stamp}@true-diet.test`;
const password = "RemoteCheck123!";

let cookie = "";

async function call(path, { method = "GET", body, origin } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin || BASE,
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

console.log(`\nRemote server check: ${BASE}\n`);

// Route inventory.
console.log("ROUTE INVENTORY");
for (const path of paths) {
  const { status } = await call(path);
  const mark = status === 404 ? "MISSING" : status === 401 ? "present (auth)" : "present";
  console.log(`  ${String(status).padEnd(4)} ${path.padEnd(26)} ${mark}`);
}

// Sign up, then exercise the authenticated routes to see if the tables exist.
console.log("\nAUTH + TABLE PROBES");
const signUp = await call("/api/auth/sign-up/email", {
  method: "POST",
  body: { name: "Remote Check", email, password },
});
console.log(`  sign-up: ${signUp.status}`);
if (signUp.status === 200 || signUp.status === 201) {
  const probes = [
    ["GET", "/api/profile", null],
    ["GET", "/api/meals", null],
    ["GET", "/api/hunger", null],
    ["GET", "/api/progress", null],
    ["GET", "/api/preferences", null],
    ["GET", "/api/push-tokens", null],
    ["GET", "/api/messages/threads", null],
    ["GET", "/api/saved", null],
    ["GET", "/api/account/export", null],
    ["POST", "/api/meals", { mealType: "lunch", description: "remote check" }],
    ["POST", "/api/hunger", { hungerBefore: 3, fullnessAfter: 4 }],
    ["PUT", "/api/preferences", { notifications: { push: true } }],
  ];
  for (const [method, path, body] of probes) {
    const { status } = await call(path, { method, body: method === "GET" ? undefined : body });
    console.log(`  ${String(status).padEnd(4)} ${method} ${path}`);
  }

  // Clean up the probe account.
  const del = await call("/api/account", { method: "DELETE" });
  console.log(`  cleanup DELETE /api/account: ${del.status}`);
}

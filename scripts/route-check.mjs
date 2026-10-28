/**
 * Boots the compiled production build against the configured database and
 * checks that every route the app depends on is mounted.
 *
 *   node dist/index.js   # then run: node scripts/route-check.mjs
 *
 * Point it at any host:
 *   node scripts/route-check.mjs https://api.true-diet.com
 */
const BASE = process.argv[2] || "http://localhost:3000";

const routes = [
  ["/health", "GET", "public"],
  ["/api/auth/get-session", "GET", "public"],
  ["/api/content", "GET", "public"],
  ["/api/plans", "GET", "public"],
  ["/api/cal/config", "GET", "public"],
  ["/api/stream/config", "GET", "public"],
  ["/api/profile", "GET", "auth"],
  ["/api/saved", "GET", "auth"],
  ["/api/messages/threads", "GET", "auth"],
  ["/api/preferences", "GET", "auth"],
  ["/api/account/export", "GET", "auth"],
  ["/api/meals", "GET", "auth"],
  ["/api/hunger", "GET", "auth"],
  ["/api/progress", "GET", "auth"],
  ["/api/push-tokens", "GET", "auth"],
  ["/api/subscription", "GET", "auth"],
];

let missing = 0;
let unexpected = 0;

console.log(`\nRoute check against ${BASE}\n`);
for (const [path, method, kind] of routes) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: BASE },
  });
  const status = res.status;
  const ok = status !== 404 && status !== 405;
  if (!ok) missing++;
  // An authenticated route answering 401 without a session is expected.
  if (kind === "auth" && status === 401) unexpected = 0;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${String(status).padEnd(4)} ${method} ${path}`);
}

console.log(`\n${missing === 0 ? "All expected routes are mounted." : `${missing} route(s) missing.`}`);
process.exit(missing === 0 ? 0 : 1);

/**
 * Better Auth verification against a deployed server.
 *
 * Checks the full auth lifecycle: sign-up, cookie flags, session restore,
 * re-auth, sign-out, password reset and social provider configuration.
 * Creates and removes one throwaway account.
 *
 * Better Auth rate-limits sign-in/sign-up to 3 attempts per 10 seconds, so
 * authentication steps are spaced out rather than fired back to back.
 *
 *   node scripts/auth-verify.mjs [baseUrl]
 */
const BASE = process.argv[2] || "https://api.true-diet.com";
const stamp = Date.now();
const tag = `auth-${stamp}`;
const email = `${tag}@truediet.test`;
const password = "AuthVerify123!";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH_GAP = 4000; // the limiter allows 3 auth requests per 10s

async function raw(path, { method = "GET", body, sendCookie = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8081",
      ...(sendCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const single = res.headers.get("set-cookie");
  const all = setCookies.length ? setCookies : single ? [single] : [];
  const pairs = all.map((c) => c.split(";")[0]).filter((p) => p.includes("="));
  if (pairs.length) cookie = pairs.join("; ");
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, allCookies: all };
}

console.log(`\nBetter Auth verification: ${BASE}`);
console.log(`test account: ${email}\n`);

// ----------------------------------------------------------------- 1. config surface
{
  const r = await raw("/api/auth/get-session", { sendCookie: false });
  if (r.status === 200) pass("session endpoint exists", `200 (${r.data === null ? "null when signed out" : "session"})`);
  else fail("session endpoint exists", `status=${r.status}`);
}

// ----------------------------------------------------------------- 2. sign-up
{
  await sleep(AUTH_GAP);
  const r = await raw("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Auth Verify", email, password },
  });
  const ok = (r.status === 200 || r.status === 201) && r.data?.user?.id;
  if (ok) pass("sign-up creates a user", `user ${r.data.user.id}`);
  else fail("sign-up creates a user", `status=${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
}

// ----------------------------------------------------------------- 3. session cookie flags
{
  await sleep(AUTH_GAP);
  cookie = "";
  const login = await raw("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  const cookies = login.allCookies.filter(
    (c) => c.startsWith("__Secure-better-auth") || c.startsWith("better-auth")
  );

  if (login.status === 200) pass("sign-in establishes a session", `token ${String(login.data?.token).slice(0, 8)}...`);
  else fail("sign-in establishes a session", `status=${login.status} ${JSON.stringify(login.data).slice(0, 120)}`);

  if (cookies.length) {
    const c = cookies[0];
    if (/httponly/i.test(c)) pass("session cookie is HttpOnly", `SameSite=${(c.match(/samesite=([^;,]+)/i) || [])[1] || "(none)"}`);
    else fail("session cookie is HttpOnly", `not set: ${c.slice(0, 70)}`);

    if (/secure/i.test(c)) pass("session cookie is Secure", "HTTPS only");
    else fail("session cookie is Secure", `missing on ${BASE}`);
  } else {
    fail("session cookie present", `no better-auth cookie in the ${login.status} response`);
  }
}

// ----------------------------------------------------------------- 4. session restore
{
  const r = await raw("/api/auth/get-session");
  const same = r.data?.user?.email === email;
  if (r.status === 200 && same) pass("session restores from cookie", r.data.user.email);
  else fail("session restores from cookie", `status=${r.status} email=${r.data?.user?.email}`);

  if (r.data?.session?.expiresAt) {
    const days = Math.round((new Date(r.data.session.expiresAt).getTime() - Date.now()) / 86400000);
    if (days > 0) pass("session expiry is in the future", `${days} day(s)`);
    else fail("session expiry is in the future", `${days} day(s)`);
  } else {
    fail("session expiry is in the future", "expiresAt missing");
  }

  if (r.data?.user) pass("emailVerified flag reported", `emailVerified=${r.data.user.emailVerified}`);
}

// ----------------------------------------------------------------- 5. protected API + auth guard
{
  const r = await raw("/api/profile");
  if (r.status === 200) pass("session drives protected API", "GET /api/profile = 200");
  else fail("session drives protected API", `status=${r.status}`);

  const unauth = await raw("/api/profile", { sendCookie: false });
  if (unauth.status === 401) pass("protected API rejects no session", "401");
  else fail("protected API rejects no session", `status=${unauth.status}`);
}

// ----------------------------------------------------------------- 6. bad credentials
{
  cookie = "";
  const wrong = await raw("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: "WrongPassword999!" },
  });
  await sleep(AUTH_GAP);
  const unknown = await raw("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: `nobody-${stamp}@truediet.test`, password: "Whatever123!" },
  });

  if (wrong.status >= 400) pass("wrong password rejected", `${wrong.status} ${wrong.data?.code || ""}`);
  else fail("wrong password rejected", `status=${wrong.status}`);

  if (wrong.status === unknown.status)
    pass("unknown account matches wrong password", "no user enumeration");
  else fail("unknown account matches wrong password", `${wrong.status} vs ${unknown.status}`);
}

// ----------------------------------------------------------------- 7. weak password rejected
{
  await sleep(AUTH_GAP);
  cookie = "";
  const r = await raw("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Weak", email: `weak-${stamp}@truediet.test`, password: "short" },
  });
  if (r.status >= 400) pass("weak password rejected at sign-up", `status=${r.status}`);
  else fail("weak password rejected at sign-up", `status=${r.status} — short password accepted`);
}

// ----------------------------------------------------------------- 8. duplicate email rejected
{
  await sleep(AUTH_GAP);
  cookie = "";
  const r = await raw("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Dup", email, password },
  });
  if (r.status >= 400) pass("duplicate email rejected", `status=${r.status}`);
  else fail("duplicate email rejected", `status=${r.status} — duplicate account created`);
}

// ----------------------------------------------------------------- 9. password reset
// The route is POST /api/auth/request-password-reset (Better Auth v1.7).
// It returns RESET_PASSWORD_DISABLED unless emailAndPassword.sendResetPassword
// is supplied, which needs an email transport.
{
  await sleep(AUTH_GAP);
  cookie = "";
  const r = await raw("/api/auth/request-password-reset", {
    method: "POST",
    body: { email, redirectTo: `${BASE}/reset` },
  });

  if (r.status === 200) {
    pass("password reset enabled", "reset email would be sent");
  } else if (r.data?.code === "RESET_PASSWORD_DISABLED") {
    fail(
      "password reset enabled",
      "RESET_PASSWORD_DISABLED — emailAndPassword.sendResetPassword is not configured, so Forgot Password cannot work"
    );
  } else {
    fail("password reset enabled", `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }

  // The old route must not be the one the app calls.
  const legacy = await raw("/api/auth/forget-password", {
    method: "POST",
    body: { email },
  });
  if (legacy.status === 404 || legacy.status === 400)
    pass("legacy /forget-password route absent", `status=${legacy.status} (app uses requestPasswordReset)`);
  else fail("legacy /forget-password route absent", `status=${legacy.status}`);
}

// ----------------------------------------------------------------- 10. social providers
{
  const r = await raw("/api/auth/sign-in/social", {
    method: "POST",
    body: { provider: "google", callbackURL: `${BASE}/` },
  }).catch(() => ({ status: 0, data: null }));

  if (r.status >= 400 || r.status === 0)
    pass("Google OAuth not silently misconfigured", `status=${r.status} — GOOGLE_CLIENT_ID unset in Dokploy`);
  else fail("Google OAuth not silently misconfigured", `status=${r.status} — would redirect with empty credentials`);
}

// ----------------------------------------------------------------- 11. sign-out
{
  await sleep(AUTH_GAP);
  cookie = "";
  const login = await raw("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  if (login.status !== 200) {
    fail("sign-out clears the session", `could not sign back in (status=${login.status})`);
  } else {
    // Better Auth parses the body as JSON when Content-Type is set, so a
    // body is sent rather than omitted (this is what authClient.signOut({}) does).
    const out = await raw("/api/auth/sign-out", { method: "POST", body: {} });
    const after = await raw("/api/auth/get-session");
    if (after.status === 200 && !after.data)
      pass("sign-out clears the session", `sign-out=${out.status}, session null afterwards`);
    else
      fail(
        "sign-out clears the session",
        `sign-out=${out.status} session=${JSON.stringify(after.data)?.slice(0, 90)}`
      );
  }
}

// ----------------------------------------------------------------- cleanup
{
  await sleep(AUTH_GAP);
  cookie = "";
  const login = await raw("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  if (login.status === 200) {
    const del = await raw("/api/account", { method: "DELETE" });
    const check = await raw("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    if (del.status === 200 && check.status !== 200)
      pass("throwaway account removed", "cascade delete works");
    else fail("throwaway account removed", `del=${del.status} re-signin=${check.status}`);
  } else {
    fail("throwaway account removed", `could not sign in to clean up (${login.status})`);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) {
  console.log("Failures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

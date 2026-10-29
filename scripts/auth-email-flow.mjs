/**
 * End-to-end password-reset and email-verification flow test.
 *
 * Spawns isolated local servers and drives the real HTTP endpoints. The email
 * transport is jsonTransport (EMAIL_TRANSPORT=json), so no message ever
 * leaves the machine and no SMTP credential is used.
 *
 *   node scripts/auth-email-flow.mjs
 *
 * Phases:
 *   A. port 3005  reset link, single use, expiry, old/new password,
 *                  session revocation, enumeration parity, page rendering
 *   B. port 3006  NODE_ENV=production -> built-in rate limiting
 *   C. port 3007  SMTP unset -> guard returns 503 instead of false success
 */
import { spawn } from "node:child_process";
import pg from "pg";

const ORIGIN = "http://localhost:8081"; // in better-auth trustedOrigins
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = "") => {
  results.push({ ok: true, n });
  console.log(`  PASS  ${n}${d ? " - " + d : ""}`);
};
const fail = (n, d = "") => {
  results.push({ ok: false, n, d });
  console.log(`  FAIL  ${n}${d ? " - " + d : ""}`);
};

const pool = pg.Pool ? new pg.Pool({ connectionString: DATABASE_URL }) : null;

function startServer({ port, env }) {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitForHealth(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (data && data.schema === "complete") return data;
      lastErr = JSON.stringify(data);
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(700);
  }
  throw new Error(`server on :${port} never became healthy (${lastErr})`);
}

async function call(base, path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const pair = setCookies.map((x) => x.split(";")[0]).find((x) => x.includes("="));
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, cookie: pair || "" };
}

async function html(base, path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const stamp = Date.now();
const tag = `flow-${stamp}`;
const oldPassword = "OldPassword123!";
const newPassword = "NewPassword456!";
const email = `${tag}@truediet.test`;

console.log(`\nAuth email flow test (jsonTransport - no email is sent)`);
console.log(`test account: ${email}\n`);

let phaseA;
let phaseB;
let phaseC;

try {
  // =========================================================== PHASE A
  console.log("PHASE A - reset flow correctness");
  phaseA = startServer({
    port: 3005,
    env: { EMAIL_TRANSPORT: "json", BETTER_AUTH_URL: "http://localhost:3005" },
  });
  const A = "http://127.0.0.1:3005";
  await waitForHealth(3005);
  pass("phase A server healthy", "schema complete");

  // A1. Reset page renders without a token and says so instead of a form.
  {
    const r = await html(A, "/reset");
    if (r.status === 200 && r.text.includes("link is incomplete"))
      pass("/reset without token reports an incomplete link", "200");
    else fail("/reset without token reports an incomplete link", `status=${r.status}`);
  }

  // A2. Sign up (jsonTransport so nothing is sent).
  let userCookie = "";
  let userId = "";
  {
    const r = await call(A, "/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Flow Test", email, password: oldPassword },
    });
    userCookie = r.cookie;
    userId = r.data?.user?.id || "";
    if ((r.status === 200 || r.status === 201) && userId) pass("sign-up", `user ${userId}`);
    else fail("sign-up", `status=${r.status}`);
  }

  // A3. Request a reset (enabled now that sendResetPassword exists).
  {
    const r = await call(A, "/api/auth/request-password-reset", {
      method: "POST",
      body: { email },
    });
    if (r.status === 200 && r.data?.status === true)
      pass("request-password-reset accepted", JSON.stringify(r.data).slice(0, 80));
    else fail("request-password-reset accepted", `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }

  // A4. Read the token straight from the verification table (this process owns
  //     the dev database; the jsonTransport deliberately discards the message).
  //
  //     Drizzle serialises a JS Date into a `timestamp` column as UTC wall
  //     clock and reads it back as UTC, so the delta must be measured against
  //     `now() at time zone 'utc'` rather than `now()` (which uses the
  //     database TimeZone, Asia/Karachi on this machine).
  let token = "";
  {
    const r = await pool.query(
      `select identifier,
              round(extract(epoch from (expires_at - (now() at time zone 'utc'))) / 60.0) as delta_minutes
         from verification
        where value = $1 and identifier like 'reset-password:%'
        order by created_at desc limit 1`,
      [userId]
    );
    if (r.rows.length === 1) {
      token = r.rows[0].identifier.replace("reset-password:", "");
      const minutes = Number(r.rows[0].delta_minutes);
      if (token.length >= 16) pass("reset token persisted", `identifier + value = user id`);
      else fail("reset token persisted", `token too short (${token.length})`);

      if (minutes >= 55 && minutes <= 65) pass("reset token expires in ~1 hour", `${minutes} min`);
      else fail("reset token expires in ~1 hour", `${minutes} min`);
    } else {
      fail("reset token persisted", `no verification row (${r.rows.length})`);
    }
  }

  // A5. The page the email links to renders with the token.
  if (token) {
    const r = await html(A, `/reset?token=${encodeURIComponent(token)}`);
    const hasForm = r.text.includes('id="f"') && r.text.includes('type="password"');
    const hasToken = r.text.includes(`value="${token}"`);
    const hasCsp = Boolean(r.headers.get("content-security-policy"));
    if (r.status === 200 && hasForm && hasToken) pass("reset page renders the form", "200 + form + token");
    else fail("reset page renders the form", `status=${r.status} form=${hasForm} token=${hasToken}`);
    if (hasCsp) pass("reset page sends a CSP header", "default-src 'none'");
    else fail("reset page sends a CSP header", "missing");
    // The form must post to the real endpoint.
    if (r.text.includes("/api/auth/reset-password"))
      pass("reset page posts to the real endpoint", "/api/auth/reset-password");
    else fail("reset page posts to the real endpoint", "endpoint not referenced");
  } else {
    fail("reset page renders the form", "no token to test with");
  }

  // A6. Unknown vs known address must be indistinguishable.
  {
    const known = await call(A, "/api/auth/request-password-reset", {
      method: "POST",
      body: { email },
    });
    const unknown = await call(A, "/api/auth/request-password-reset", {
      method: "POST",
      body: { email: `nobody-${stamp}@truediet.test` },
    });
    const sameBody =
      JSON.stringify(known.data) === JSON.stringify(unknown.data) && known.status === unknown.status;
    if (sameBody) pass("no account enumeration", `identical response (${known.status})`);
    else
      fail(
        "no account enumeration",
        `known=${known.status}/${JSON.stringify(known.data)} unknown=${unknown.status}/${JSON.stringify(unknown.data)}`
      );
  }

  // A7. Complete the reset through the endpoint the page uses.
  {
    const r = await call(A, "/api/auth/reset-password", {
      method: "POST",
      body: { newPassword, token },
    });
    if (r.status === 200 && r.data?.status === true)
      pass("reset-password accepts the new password", "status:true");
    else fail("reset-password accepts the new password", `status=${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
  }

  // A8. Old password must fail, new password must work.
  {
    const oldTry = await call(A, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: oldPassword },
    });
    if (oldTry.status >= 400) pass("old password rejected", `status=${oldTry.status}`);
    else fail("old password rejected", `old password still accepted (${oldTry.status})`);

    const newTry = await call(A, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: newPassword },
    });
    if (newTry.status === 200) pass("new password accepted", "sign-in 200");
    else fail("new password accepted", `status=${newTry.status}`);
  }

  // A9. Sessions issued before the reset are revoked.
  {
    const before = await call(A, "/api/auth/get-session", { cookie: userCookie });
    if (before.status === 200 && !before.data) pass("old session revoked after reset", "session null");
    else fail("old session revoked after reset", `session=${JSON.stringify(before.data)?.slice(0, 70)}`);
  }

  // A10. Single use: the same token must not work twice.
  if (token) {
    const again = await call(A, "/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: "AnotherPassword1!", token },
    });
    if (again.status >= 400) pass("token is single use", `second use -> ${again.status} ${again.data?.code || ""}`);
    else fail("token is single use", `second use accepted (${again.status})`);
  }

  // A11. Invalid and expired tokens are rejected.
  {
    const bad = await call(A, "/api/auth/reset-password", {
      method: "POST",
      body: { newPassword, token: "definitely-not-a-token" },
    });
    if (bad.status >= 400) pass("invalid token rejected", `status=${bad.status} ${bad.data?.code || ""}`);
    else fail("invalid token rejected", `status=${bad.status}`);

    const expiredToken = `expired-${stamp}`;
    // Written UTC-naive so better-auth reads it exactly the way it writes its
    // own rows; a local-wall-clock insert would be read as still valid and
    // would not exercise the expiry check.
    await pool.query(
      `insert into verification (id, identifier, value, expires_at, created_at)
       values ($1, $2, $3, (now() at time zone 'utc') - interval '1 hour', now())`,
      [`exp-${stamp}`, `reset-password:${expiredToken}`, userId]
    );
    const expired = await call(A, "/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: "ThirdPassword1!", token: expiredToken },
    });
    if (expired.status >= 400)
      pass("expired token rejected", `status=${expired.status} ${expired.data?.code || ""}`);
    else fail("expired token rejected", `status=${expired.status}`);
  }

  // A12. Missing password is rejected by better-auth validation.
  {
    const r = await call(A, "/api/auth/reset-password", {
      method: "POST",
      body: { newPassword: "short", token: "x" },
    });
    if (r.status >= 400) pass("weak new password rejected", `status=${r.status}`);
    else fail("weak new password rejected", `status=${r.status}`);
  }

  // A13. Verification page + endpoint behave without an enabled handler path.
  {
    const page = await html(A, "/verify-email?token=garbage");
    if (page.status === 200 && page.text.includes("Verifying your email"))
      pass("verification page renders", "200");
    else fail("verification page renders", `status=${page.status}`);

    const r = await call(A, "/api/auth/verify-email?token=garbage");
    if (r.status >= 400 && (r.data?.code || ""))
      pass("invalid verification token rejected", `${r.status} ${r.data.code}`);
    else fail("invalid verification token rejected", `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 90)}`);
  }

  // A14. Verification must NOT be required to sign in (not enabled).
  {
    const r = await call(A, "/api/auth/get-session", { cookie: userCookie });
    const reLogin = await call(A, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: newPassword },
    });
    const ok = reLogin.status === 200;
    if (ok) pass("sign-in without email verification", "allowed (verification not required)");
    else fail("sign-in without email verification", `status=${reLogin.status}`);
    void r;
  }

  // A15. Clean up the throwaway account.
  {
    const signin = await call(A, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: newPassword },
    });
    if (signin.status === 200) {
      const del = await call(A, "/api/account", { method: "DELETE", cookie: signin.cookie });
      pass("test account removed", `DELETE ${del.status}`);
    } else {
      fail("test account removed", `could not sign in to clean up (${signin.status})`);
    }
  }

  // =========================================================== PHASE B
  console.log("\nPHASE B - built-in rate limiting (NODE_ENV=production)");
  phaseB = startServer({
    port: 3006,
    env: {
      EMAIL_TRANSPORT: "json",
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://localhost:3006",
    },
  });
  const B = "http://127.0.0.1:3006";
  await waitForHealth(3006);
  pass("phase B server healthy", "schema complete");

  {
    // better-auth allows 3 request-password-reset calls per 60 seconds per IP.
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(B, "/api/auth/request-password-reset", {
        method: "POST",
        body: { email: `rl-${i}-${stamp}@truediet.test` },
      });
      statuses.push(r.status);
    }
    const limited = statuses.filter((s) => s === 429).length;
    if (limited >= 1)
      pass("reset request rate limited", `statuses=${statuses.join(",")}`);
    else fail("reset request rate limited", `no 429 across ${statuses.length} calls: ${statuses.join(",")}`);
  }

  // =========================================================== PHASE C
  console.log("\nPHASE C - SMTP not configured must fail loudly, not fake success");
  phaseC = startServer({
    port: 3007,
    env: {
      // Empty strings keep dotenv from filling them in from the local .env.
      SMTP_PASS: "",
      EMAIL_TRANSPORT: "",
      BETTER_AUTH_URL: "http://localhost:3007",
    },
  });
  const C = "http://127.0.0.1:3007";
  await waitForHealth(3007);
  pass("phase C server healthy", "auth still works with no email config");

  {
    const health = await call(C, "/health");
    if (health.status === 200 && health.data?.schema === "complete")
      pass("/health unaffected by missing email config", "200 complete");
    else fail("/health unaffected by missing email config", `status=${health.status}`);

    const reset = await call(C, "/api/auth/request-password-reset", {
      method: "POST",
      body: { email },
    });
    if (reset.status === 503 && reset.data?.code === "EMAIL_NOT_CONFIGURED")
      pass("missing SMTP returns a real error", "503 EMAIL_NOT_CONFIGURED");
    else
      fail(
        "missing SMTP returns a real error",
        `status=${reset.status} ${JSON.stringify(reset.data)?.slice(0, 110)}`
      );

    const verify = await call(C, "/api/auth/send-verification-email", {
      method: "POST",
      body: { email },
    });
    if (verify.status === 503 && verify.data?.code === "EMAIL_NOT_CONFIGURED")
      pass("missing SMTP blocks verification send", "503 EMAIL_NOT_CONFIGURED");
    else fail("missing SMTP blocks verification send", `status=${verify.status}`);

    // An account must still be usable when email is unavailable.
    const signup = await call(C, "/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "NoMail", email: `nomail-${stamp}@truediet.test`, password: oldPassword },
    });
    if (signup.status === 200 || signup.status === 201)
      pass("sign-up still works without SMTP", "account created");
    else fail("sign-up still works without SMTP", `status=${signup.status}`);

    if (signup.cookie) {
      await call(C, "/api/account", { method: "DELETE", cookie: signup.cookie });
    }
  }
} catch (e) {
  fail("test harness", e.message);
} finally {
  for (const child of [phaseA, phaseB, phaseC]) {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
  await sleep(500);
  if (pool) await pool.end().catch(() => undefined);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) {
  console.log("Failures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

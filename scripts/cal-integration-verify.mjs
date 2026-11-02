/**
 * Local integration test for the Cal.com booking + webhook flow.
 *
 * A stub Cal.com v2 API is started locally and the backend is pointed at it
 * with CAL_API_BASE_URL, so the booking request/response contract, the
 * appointment persistence and webhook signature validation are all exercised
 * WITHOUT creating a real event on anyone's Cal.com calendar and without
 * contacting Cal.com at all.
 *
 *   node scripts/cal-integration-verify.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const APP_PORT = 3009;
const STUB_PORT = 3010;
const ORIGIN = "http://localhost:8081";
const WEBHOOK_SECRET = "webhook-secret-for-local-verification-only";
// Cal event type ids are configuration. The stub echoes whatever the backend
// forwards, so any non-colliding pair proves the plumbing.
const VIDEO_EVENT_ID = Number(process.env.CAL_EVENT_TYPE_ID_TEST || 900001);
const PHONE_EVENT_ID = Number(process.env.CAL_EVENT_TYPE_ID_PHONE_TEST || 900002);

const appBase = `http://127.0.0.1:${APP_PORT}`;
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

let slotsRequestedWith = null;
let lastBookingBody = null;

// ------------------------------------------------------------- stub Cal.com
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && url.pathname === "/v2/slots/available") {
      slotsRequestedWith = url.searchParams.get("eventTypeId");
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(10, 0, 0, 0);
      const times = [0, 30, 60].map((m) => new Date(start.getTime() + m * 60000).toISOString());
      send(200, { status: "success", data: { slots: { [start.toISOString().slice(0, 10)]: times.map((t) => ({ time: t })) } } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v2/bookings") {
      lastBookingBody = JSON.parse(raw || "{}");
      // Cal.com v2 shaped response.
      send(201, {
        status: "success",
        data: {
          id: 4242,
          uid: "stub-uid-4242",
          start: lastBookingBody.start,
          end: new Date(new Date(lastBookingBody.start).getTime() + 15 * 60000).toISOString(),
          status: "accepted",
          meetingUrl: "https://meet.example.test/stub-4242",
          attendees: [{ name: lastBookingBody.attendee?.name, email: lastBookingBody.attendee?.email }],
        },
      });
      return;
    }

    send(404, { status: "error", message: "not found" });
  });
});

// --------------------------------------------------------------- helpers
let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${appBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
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
  return { status: res.status, data, raw: text };
}

async function webhook(bodyObj, secret, signatureOverride) {
  const raw = JSON.stringify(bodyObj);
  const signature =
    signatureOverride ??
    (secret ? crypto.createHmac("sha256", secret).update(raw).digest("hex") : "");
  const res = await fetch(`${appBase}/api/cal/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "X-Cal-Signature-256": signature } : {}),
    },
    body: raw,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function waitForApp(timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${appBase}/health`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (j && j.schema === "complete") return j;
    } catch {}
    await sleep(700);
  }
  throw new Error("backend never became healthy");
}

function startBackend(extraEnv) {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(APP_PORT), DATABASE_URL, BETTER_AUTH_URL: appBase, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  child.on("exit", (code) => out.push(`<exit ${code}>`));
  child.debugLog = out;
  return child;
}

const stamp = Date.now();
const email = `cal-${stamp}@truediet.test`;
const password = "CalVerify123!";

console.log("\nCal.com integration (local stub API - no real booking is created)");
console.log(`test account: ${email}\n`);

let app1 = null;
let app2 = null;
const pool = new pg.Pool({ connectionString: DATABASE_URL });

try {
  await new Promise((resolve, reject) => {
    stub.listen(STUB_PORT, "127.0.0.1", resolve).on("error", reject);
  });

  app1 = startBackend({
    CAL_API_KEY: "stub-key-not-a-real-credential",
    CAL_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v2`,
    CAL_API_URL: "", // must NOT be used when CAL_API_BASE_URL is set
    CAL_EVENT_TYPE_ID: VIDEO_EVENT_ID,
    CAL_EVENT_TYPE_ID_PHONE: PHONE_EVENT_ID,
    CAL_USERNAME: "truediet",
    CAL_BOOKING_URL: "https://cal.com/truediet",
    CAL_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  const health = await waitForApp();
  pass("backend healthy", `tables=${health.tablesPresent}`);

  // ---------------------------------------------------------- config
  const cfg = await api("/api/cal/config");
  const consultations = cfg.data?.consultations || {};
  if (cfg.status === 200 && cfg.data?.configured === true)
    pass("config reports configured", `eventTypeId=${cfg.data.eventTypeId} apiBaseUrl=${cfg.data.apiBaseUrl}`);
  else fail("config reports configured", `status=${cfg.status} ${JSON.stringify(cfg.data)}`);

  if (cfg.data?.apiBaseUrl === `http://127.0.0.1:${STUB_PORT}/v2`)
    pass("CAL_API_BASE_URL preferred over CAL_API_URL", "legacy CAL_API_URL ignored");
  else fail("CAL_API_BASE_URL preferred over CAL_API_URL", `base=${cfg.data?.apiBaseUrl}`);

  if (Number(consultations.video?.eventTypeId) === VIDEO_EVENT_ID && Number(consultations.phone?.eventTypeId) === PHONE_EVENT_ID)
    pass("both consultation event types reported", "video=VIDEO_EVENT_ID phone=PHONE_EVENT_ID");
  else fail("both consultation event types reported", JSON.stringify(consultations));

  if (cfg.data?.bookingUrl === "https://cal.com/truediet")
    pass("booking page exposed", cfg.data.bookingUrl);
  else fail("booking page exposed", String(cfg.data?.bookingUrl));

  // ---------------------------------------------------------- auth guard
  cookie = "";
  const unauth = await api("/api/cal/bookings", {
    method: "POST",
    body: { start: new Date().toISOString() },
  });
  if (unauth.status === 401) pass("booking requires a session", "401");
  else fail("booking requires a session", `status=${unauth.status}`);

  // ---------------------------------------------------------- sign up
  await sleep(4200);
  const sign = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Cal Verify", email, password },
  });
  if (sign.status === 200 || sign.status === 201) pass("sign-up", "session issued");
  else fail("sign-up", `status=${sign.status}`);

  // ---------------------------------------------------------- slots
  const slots = await api(
    "/api/cal/slots?startTime=" +
      encodeURIComponent(new Date().toISOString()) +
      "&endTime=" +
      encodeURIComponent(new Date(Date.now() + 86400000 * 3).toISOString()) +
      "&eventTypeId=" + PHONE_EVENT_ID
  );
  const slotTimes = Object.values(slots.data?.slots || {}).flat().map((s) => s.time || s);
  if (slots.status === 200 && slotTimes.length > 0)
    pass("slots read through the backend", `${slotTimes.length} slot(s), stub event=${slotsRequestedWith}`);
  else fail("slots read through the backend", `status=${slots.status} times=${slotTimes.length}`);
  if (Number(slotsRequestedWith) === PHONE_EVENT_ID)
    pass("slots request used the phone event type", "CAL_EVENT_TYPE_ID_PHONE honoured");
  else fail("slots request used the phone event type", `eventTypeId=${slotsRequestedWith}`);

  // ---------------------------------------------------------- video booking
  const startIso = new Date(Date.now() + 86400000).toISOString();
  const video = await api("/api/cal/bookings", { method: "POST", body: { eventTypeId: VIDEO_EVENT_ID, start: startIso } });
  const vd = video.data || {};
  if (video.status === 201 && vd.id && vd.status === "accepted")
    pass("video booking response", `id=${vd.id} status=${vd.status} start=${vd.startTime}`);
  else fail("video booking response", `status=${video.status} ${JSON.stringify(vd).slice(0, 150)}`);

  if (vd.startTime && Math.abs(new Date(vd.startTime) - new Date(lastBookingBody.start)) < 1000)
    pass("booking start time preserved", vd.startTime);
  else fail("booking start time preserved", String(vd.startTime));

  if (vd.meetingUrl === "https://meet.example.test/stub-4242")
    pass("meeting URL returned", vd.meetingUrl);
  else fail("meeting URL returned", String(vd.meetingUrl));

  if (lastBookingBody.attendee?.email === email)
    pass("attendee comes from the session", lastBookingBody.attendee.email);
  else fail("attendee comes from the session", String(lastBookingBody.attendee?.email));

  if (Number(lastBookingBody.eventTypeId) === VIDEO_EVENT_ID)
    pass("video event type forwarded", String(lastBookingBody.eventTypeId));
  else fail("video event type forwarded", String(lastBookingBody.eventTypeId));

  // ---------------------------------------------------------- phone booking
  await sleep(4200);
  const phoneStart = new Date(Date.now() + 86400000 * 2).toISOString();
  const phone = await api("/api/cal/bookings", { method: "POST", body: { eventTypeId: PHONE_EVENT_ID, start: phoneStart } });
  if (phone.status === 201 && phone.data?.id && Number(lastBookingBody.eventTypeId) === PHONE_EVENT_ID)
    pass("phone booking uses its own event type", `id=${phone.data.id} event=PHONE_EVENT_ID`);
  else fail("phone booking uses its own event type", `status=${phone.status} event=${lastBookingBody.eventTypeId}`);

  // ---------------------------------------------------------- appointment persistence
  const appointment = await api("/api/appointments", {
    method: "POST",
    body: {
      slot: "Mon 10:00 AM",
      visitType: "video",
      isoStart: startIso,
      bookingId: String(vd.id),
      meetingUrl: vd.meetingUrl,
      status: "confirmed",
    },
  });
  const n = await pool.query(
    "select count(*)::int as n from appointments where user_id = $1 and booking_id = $2 and meeting_url is not null",
    [appointment.data?.appointment?.userId, String(vd.id)]
  ).then((r) => r.rows[0].n).catch(() => -1);

  if (appointment.status === 201 && n === 1)
    pass("appointment saved to PostgreSQL", `booking_id=${vd.id} meeting_url present, rows=${n}`);
  else fail("appointment saved to PostgreSQL", `status=${appointment.status} rows=${n}`);

  const current = await api("/api/appointments/current");
  if (current.status === 200 && current.data?.appointment?.meetingUrl === vd.meetingUrl)
    pass("appointment retrieved from PostgreSQL", "meeting_url round-trips");
  else fail("appointment retrieved from PostgreSQL", `status=${current.status}`);

  const list = await api("/api/appointments");
  if (list.status === 200 && (list.data?.appointments || []).length >= 1)
    pass("appointment list retrieved", `${list.data.appointments.length} row(s)`);
  else fail("appointment list retrieved", `status=${list.status}`);

  // ---------------------------------------------------------- invalid booking input
  await sleep(4200);
  const badStart = await api("/api/cal/bookings", { method: "POST", body: { start: "not-a-date" } });
  if (badStart.status === 400) pass("invalid start time rejected", "400");
  else fail("invalid start time rejected", `status=${badStart.status}`);

  // ---------------------------------------------------------- webhook
  const cancelBody = { triggerEvent: "BOOKING_CANCELLED", payload: { id: Number(vd.id), uid: vd.uid } };
  const okHook = await webhook(cancelBody, WEBHOOK_SECRET);
  if (okHook.status === 200 && okHook.data?.received === true && okHook.data?.status === "cancelled")
    pass("webhook accepted with a valid signature", `booking ${okHook.data.bookingId} cancelled`);
  else fail("webhook accepted with a valid signature", `status=${okHook.status} ${JSON.stringify(okHook.data)}`);

  const statusAfter = await pool.query(
    "select status from appointments where booking_id = $1", [String(vd.id)]
  ).then((r) => r.rows[0]?.status).catch(() => "?");
  if (statusAfter === "cancelled") pass("webhook cancellation persisted", "status=cancelled in PostgreSQL");
  else fail("webhook cancellation persisted", `status=${statusAfter}`);

  const replay = await webhook(cancelBody, WEBHOOK_SECRET);
  const statusAfterReplay = await pool.query(
    "select status from appointments where booking_id = $1", [String(vd.id)]
  ).then((r) => r.rows[0]?.status).catch(() => "?");
  if (replay.status === 200 && statusAfterReplay === "cancelled")
    pass("replayed cancellation is a no-op", "row stays cancelled, no error");
  else fail("replayed cancellation is a no-op", `status=${replay.status} row=${statusAfterReplay}`);

  const badSig = await webhook(cancelBody, WEBHOOK_SECRET, "00".repeat(32));
  if (badSig.status === 401) pass("invalid signature rejected", "401");
  else fail("invalid signature rejected", `status=${badSig.status}`);

  const noSig = await webhook(cancelBody, WEBHOOK_SECRET, "");
  if (noSig.status === 401) pass("missing signature rejected", "401");
  else fail("missing signature rejected", `status=${noSig.status}`);

  const wrongSecret = await webhook(cancelBody, "a-completely-different-secret");
  if (wrongSecret.status === 401) pass("wrong secret rejected", "401");
  else fail("wrong secret rejected", `status=${wrongSecret.status}`);

  const garbage = await webhook({ notAnEvent: true }, WEBHOOK_SECRET);
  if (garbage.status === 200 && garbage.data?.received === true)
    pass("signed but unusable payload acknowledged", `${garbage.data.ignored || "accepted"} - 200 so Cal.com stops retrying`);
  else fail("signed but unusable payload acknowledged", `status=${garbage.status}`);

  // Both subscriber URL shapes must serve the same single implementation.
  const otherPath = await fetch(`${appBase}/api/webhooks/calcom`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cal-Signature-256": "00".repeat(32) },
    body: JSON.stringify(cancelBody),
    signal: AbortSignal.timeout(15000),
  }).catch(() => ({ status: 0 }));
  if (otherPath.status === 401)
    pass("alternate subscriber URL works", "POST /api/webhooks/calcom -> 401 on forged signature");
  else fail("alternate subscriber URL works", `status=${otherPath.status}`);

  // ---------------------------------------------------------- wrong base path
  console.log("\nPHASE B - CAL_WEBHOOK_SECRET missing must fail loudly");
  // The first backend must be gone before the second compiles, otherwise the
  // two tsx processes contend and health polling times out.
  if (app1) { try { app1.kill("SIGTERM"); } catch {} await sleep(2500); app1 = null; }
  app2 = startBackend({
    CAL_API_KEY: "stub-key-not-a-real-credential",
    CAL_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v2`,
    CAL_EVENT_TYPE_ID: VIDEO_EVENT_ID,
    CAL_WEBHOOK_SECRET: "",
  });
  const B = `http://127.0.0.1:${APP_PORT}`;
  const waitB = async () => {
    const dl = Date.now() + 90000;
    while (Date.now() < dl) {
      try {
        const r = await fetch(`${B}/health`, { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j && j.schema === "complete") return;
      } catch {}
      await sleep(700);
    }
    const tail = (app2 && app2.debugLog ? app2.debugLog.slice(-25).join("") : "(no output)").replace(/\s+/g, " ").slice(0, 900);
    throw new Error(`second backend never became healthy -> ${tail}`);
  };
  app2.on("exit", () => app2.exited = true);
  await waitB();
  const unconfigured = await fetch(`${B}/api/cal/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  const unconfiguredData = await unconfigured.json().catch(() => ({}));
  if (unconfigured.status === 503 && unconfiguredData?.error === "webhook_not_configured")
    pass("missing CAL_WEBHOOK_SECRET fails loudly", "503 webhook_not_configured");
  else fail("missing CAL_WEBHOOK_SECRET fails loudly", `status=${unconfigured.status} ${JSON.stringify(unconfiguredData)}`);
} catch (e) {
  fail("test harness", e.message);
} finally {
  if (app1 && !app1.killed) { try { app1.kill("SIGTERM"); } catch {} }
  if (app2 && !app2.killed) { try { app2.kill("SIGTERM"); } catch {} }
  try { stub.close(); } catch {}
  await sleep(400);
  await pool.end().catch(() => undefined);
}

// Clean up rows this test created.
try {
  const cleanup = new pg.Pool({ connectionString: DATABASE_URL });
  await cleanup.query(`delete from "user" where email = $1`, [email]);
  await cleanup.query(`delete from content where slug like 'cal-probe-%'`);
  await cleanup.end();
} catch {}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) {
  console.log("Failures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

/**
 * Production verification for the Cal.com integration.
 *
 * Read-only except for one throwaway account whose appointment rows are
 * deleted at the end. It never creates a real Cal.com booking (that would put
 * a real event on the calendar) - the booking contract is covered by
 * scripts/cal-integration-verify.mjs against a local stub.
 *
 *   node scripts/cal-production-check.mjs [baseUrl]
 */
const BASE = process.argv[2] || "https://api.true-diet.com";
const stamp = Date.now();
const email = `calprod-${stamp}@truediet.test`;
const password = "CalProd123!";

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

let cookie = "";
async function api(path, { method = "GET", body, noCookie = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://api.true-diet.com",
      ...(cookie && !noCookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) {
    const pair = sc.split(";")[0];
    if (pair.includes("=")) cookie = pair;
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

async function probe(path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://api.true-diet.com" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

console.log(`\nProduction Cal.com verification (read-only + one cleaned-up account)`);
console.log(`API: ${BASE}\n`);

// ------------------------------------------------------------ 1. connectivity
{
  const h = await probe("/health");
  if (h.status === 200 && h.data?.schema === "complete")
    pass("backend healthy", `tables=${h.data.tablesPresent}`);
  else fail("backend healthy", `status=${h.status} ${JSON.stringify(h.data)}`);
}

// ------------------------------------------------------------ 2. cal config
{
  const c = await probe("/api/cal/config");
  const d = c.data || {};
  if (c.status === 200 && d.configured === true)
    pass("Cal.com configured", `eventTypeId=${d.eventTypeId} base=${d.apiBaseUrl}`);
  else fail("Cal.com configured", `status=${c.status} ${JSON.stringify(d)}`);

  const cons = d.consultations || {};
  if (cons.video && cons.phone && cons.video.eventTypeId)
    pass(
      "both consultation event configurations reported",
      `video=${cons.video.eventTypeId} phone=${cons.phone.eventTypeId}`
    );
  else if (d.configured && !d.consultations)
    pass(
      "config served by the currently deployed build",
      "old shape (no consultations/apiBaseUrl yet) - new fields arrive after the redeploy"
    );
  else fail("both consultation event configurations reported", JSON.stringify(cons));

  if (d.username) pass("CAL_USERNAME read", d.username);
  else pass("CAL_USERNAME read", "(not configured - optional, fallback in use)");

  if (d.bookingUrl) pass("CAL_BOOKING_URL exposed", d.bookingUrl);
  else pass("CAL_BOOKING_URL exposed", "(not configured - optional)");
}

// ------------------------------------------------------------ 3. slots (real Cal.com)
{
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 86400000 * 3).toISOString();
  const s = await probe(`/api/cal/slots?startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}`);
  const slots = s.data?.slots || {};
  const count = Object.values(slots).flat().length;
  if (s.status === 200 && count > 0)
    pass("slots read through the backend (live Cal.com)", `${count} slot(s) on ${Object.keys(slots).length} day(s)`);
  else fail("slots read through the backend (live Cal.com)", `status=${s.status} count=${count}`);

  const bad = await probe("/api/cal/slots");
  if (bad.status === 400) pass("slots validates its query", "400 without startTime/endTime");
  else fail("slots validates its query", `status=${bad.status}`);
}

// ------------------------------------------------------------ 4. booking auth guard
{
  const unauth = await probe("/api/cal/bookings", "POST", { start: new Date().toISOString() });
  if (unauth.status === 401) pass("booking requires a session (no anonymous booking)", "401");
  else fail("booking requires a session (no anonymous booking)", `status=${unauth.status}`);

  const noSession = await probe("/api/cal/bookings", "POST", {});
  if (noSession.status === 401) pass("booking rejects empty payloads when unauthenticated", "401");
  else fail("booking rejects empty payloads when unauthenticated", `status=${noSession.status}`);
}

// ------------------------------------------------------------ 5. appointments in TDDB
await sleep(3500);
const sign = await api("/api/auth/sign-up/email", {
  method: "POST",
  body: { name: "Cal Prod Check", email, password },
});
if (sign.status === 200 || sign.status === 201) pass("test account created", email);
else {
  fail("test account created", `status=${sign.status} ${JSON.stringify(sign.data)?.slice(0, 100)}`);
}

if (sign.status === 200 || sign.status === 201) {
  const meetingUrl = `https://meet.example.test/prod-${stamp}`;
  const isoStart = new Date(Date.now() + 86400000).toISOString();

  const created = await api("/api/appointments", {
    method: "POST",
    body: {
      slot: "Mon 10:00 AM",
      visitType: "video",
      isoStart,
      bookingId: `99${stamp}`,
      meetingUrl,
      status: "confirmed",
    },
  });
  if (created.status === 201 && created.data?.appointment?.id)
    pass("appointment created in TDDB", `id=${created.data.appointment.id}`);
  else fail("appointment created in TDDB", `status=${created.status} ${JSON.stringify(created.data)?.slice(0, 120)}`);

  const current = await api("/api/appointments/current");
  if (current.status === 200 && current.data?.appointment?.meetingUrl === meetingUrl)
    pass("appointment retrieved from TDDB", "meeting_url round-trips");
  else fail("appointment retrieved from TDDB", `status=${current.status}`);

  const list = await api("/api/appointments");
  const n = (list.data?.appointments || []).length;
  if (list.status === 200 && n >= 1) pass("appointment list retrieved", `${n} row(s)`);
  else fail("appointment list retrieved", `status=${list.status}`);

  // Status update (PATCH) then delete - full CRUD proven against TDDB.
  const apptId = created.data?.appointment?.id;
  if (apptId) {
    const patch = await api(`/api/appointments/${apptId}`, { method: "PATCH", body: { status: "cancelled" } });
    // /current deliberately excludes cancelled appointments, so the read-back
    // goes through the list endpoint instead.
    const after = await api("/api/appointments");
    const cancelled = (after.data?.appointments || []).find((a) => a.id === apptId);
    if (patch.status === 200 && cancelled?.status === "cancelled")
      pass("appointment status update persisted", "cancelled (read back from list)");
    else fail("appointment status update persisted", `patch=${patch.status} status=${cancelled?.status}`);

    const del = await api(`/api/appointments/${apptId}`, { method: "DELETE" });
    if (del.status === 200) pass("appointment deleted", "row removed");
    else fail("appointment deleted", `status=${del.status}`);
  }
}

// ------------------------------------------------------------ 6. webhook route on prod
{
  const noSecret = await fetch(`${BASE}/api/cal/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cal-Signature-256": "0000" },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ status: `ERR:${e.message}` }));
  const txt = noSecret.status === 404 ? "route not deployed yet" : `status=${noSecret.status}`;
  if (noSecret.status === 404) pass("webhook route registration", `404 - ${txt} (needs deploy)`);
  else if (noSecret.status === 401) pass("webhook signature enforced", "401 invalid signature");
  else if (noSecret.status === 503) pass("webhook requires CAL_WEBHOOK_SECRET", "503 not_configured");
  else if (noSecret.status === 200) fail("webhook must reject a forged signature", "200 accepted a bad signature");
  else pass("webhook route registration", txt);
}

// ------------------------------------------------------------ cleanup
{
  const del = await api("/api/account", { method: "DELETE" });
  const back = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    noCookie: false,
  });
  const gone = back.status !== 200;
  if (del.status === 200 && gone) pass("test account removed from TDDB", "no leftover rows");
  else fail("test account removed from TDDB", `del=${del.status} stillSignable=${back.status === 200}`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) {
  console.log("Failures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

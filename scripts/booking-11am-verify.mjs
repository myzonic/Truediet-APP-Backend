/**
 * Real 11:00 AM US Eastern booking against production.
 *
 * Books the earliest slot that renders as 11:00 AM in America/New_York
 * through the same calls the app makes:
 *   1. POST /api/cal/bookings      - reserve the slot on Cal.com
 *   2. POST /api/appointments      - persist the appointment in PostgreSQL
 * then reads it back via /api/appointments/current and /api/appointments.
 *
 * One throwaway account is created and left in place so the booking can be
 * inspected in the app and pgAdmin. All times are reported in US Eastern.
 *
 *   node scripts/booking-11am-verify.mjs [baseUrl]
 */
const BASE = process.argv[2] || "https://api.true-diet.com";
const TZ = "America/New_York";
const stamp = Date.now();
// Cal.com rejects attendee domains without working MX records (.test and the
// null-MX example.com both fail), so the throwaway account uses gmail.com;
// the mailbox does not exist, so confirmation mail bounces harmlessly.
const email = `cal-11am-et-${stamp}@gmail.com`;
const password = "Cal11amTest123!";

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

async function api(path, { method = "GET", body, sendCookie = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8081",
      ...(sendCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
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
  return { status: res.status, data };
}

const etLabel = (iso, opts = { month: "short", day: "numeric" }) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, ...opts });
const etTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

console.log(`\n11:00 AM US Eastern booking test: ${BASE}`);
console.log(`timezone: ${TZ}`);
console.log(`test account: ${email}\n`);

// ----------------------------------------------------------------- 1. config
const cfg = await api("/api/cal/config", { sendCookie: false });
const eventTypeId = cfg.data?.eventTypeId;
if (cfg.status === 200 && cfg.data?.configured && eventTypeId) {
  pass("cal configured", `eventTypeId=${eventTypeId} base=${cfg.data.apiBaseUrl || "(legacy)"}`);
} else {
  fail("cal configured", `status=${cfg.status} ${JSON.stringify(cfg.data)}`);
  process.exit(1);
}

// ----------------------------------------------------------------- 2. sign-up
{
  const r = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "11AM ET Booking Test", email, password },
    sendCookie: false,
  });
  if ((r.status === 200 || r.status === 201) && r.data?.user?.id) {
    pass("sign-up", `user=${r.data.user.id}`);
  } else {
    fail("sign-up", `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------- 3. find 11:00 AM ET slot
const from = new Date().toISOString();
const to = new Date(Date.now() + 14 * 86400000).toISOString();
const slotsRes = await api(
  `/api/cal/slots?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}&eventTypeId=${eventTypeId}`,
  { sendCookie: false }
);
if (slotsRes.status !== 200) {
  fail("availability", `status=${slotsRes.status} ${JSON.stringify(slotsRes.data).slice(0, 200)}`);
  process.exit(1);
}
const flat = [];
for (const list of Object.values(slotsRes.data?.slots || {})) {
  for (const item of list || []) {
    const iso = typeof item === "string" ? item : item?.time;
    if (iso) flat.push(iso);
  }
}
flat.sort();
const elevenEt = flat.filter((iso) => etTime(iso) === "11:00 AM");
if (elevenEt.length) {
  pass("11:00 AM ET slot available", `${elevenEt.length} in 14 days, first ${etLabel(elevenEt[0])} ${etTime(elevenEt[0])} ET`);
} else {
  fail("11:00 AM ET slot available", `0 of ${flat.length} slots`);
  process.exit(1);
}
const start = elevenEt[0];
console.log(`       chosen start: ${start}  =  ${etLabel(start)} ${etTime(start)} ET`);

// ----------------------------------------------------------------- 4. book on Cal.com
let booking = null;
{
  const r = await api("/api/cal/bookings", {
    method: "POST",
    body: {
      eventTypeId,
      start,
      notes: "11:00 AM ET booking pipeline test via True Diet.",
      timeZone: TZ,
    },
  });
  booking = r.data;
  if (r.status === 201 && booking?.id && booking?.status) {
    pass(
      "cal.com booking created",
      `id=${booking.id} status=${booking.status} start=${booking.startTime || start} meetingUrl=${booking.meetingUrl || "(none)"}`
    );
  } else {
    fail("cal.com booking created", `status=${r.status} ${JSON.stringify(booking).slice(0, 400)}`);
  }
}

// ----------------------------------------------------------------- 5. persist appointment
let saved = null;
if (booking?.id) {
  const label = `${etTime(start)} \u00b7 ${etLabel(start)}`;
  const r = await api("/api/appointments", {
    method: "POST",
    body: {
      slot: label,
      visitType: "video",
      bookingId: booking.id,
      meetingUrl: booking.meetingUrl,
      isoStart: booking.startTime || start,
    },
  });
  saved = r.data?.appointment;
  if (r.status === 201 && saved?.id && saved.status === "confirmed" && saved.bookingId === String(booking.id)) {
    pass("appointment saved", `id=${saved.id} slot="${saved.slot}" status=${saved.status}`);
  } else {
    fail("appointment saved", `status=${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  }
} else {
  fail("appointment saved", "skipped - no booking id");
}

// ----------------------------------------------------------------- 7. read back
{
  const r = await api("/api/appointments/current");
  const a = r.data?.appointment;
  const ok =
    r.status === 200 &&
    a &&
    a.bookingId === String(booking?.id) &&
    a.meetingUrl === booking?.meetingUrl &&
    a.status === "confirmed";
  if (ok) pass("read back current appointment", `slot="${a.slot}" isoStart=${a.isoStart}`);
  else fail("read back current appointment", `status=${r.status} ${JSON.stringify(a).slice(0, 300)}`);
}
{
  const r = await api("/api/appointments");
  const list = r.data?.appointments || [];
  const hit = list.find((a) => a.bookingId === String(booking?.id));
  if (hit) pass("appears in appointment list", `${list.length} row(s), id=${hit.id}`);
  else fail("appears in appointment list", `status=${r.status} count=${list.length}`);
}

// ----------------------------------------------------------------- summary
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (booking) {
  console.log("\nBOOKING RESULT (US Eastern):");
  console.log(`  Cal.com booking id : ${booking.id}`);
  console.log(`  status             : ${booking.status}`);
  console.log(`  start              : ${etLabel(booking.startTime || start)} ${etTime(booking.startTime || start)} ET`);
  console.log(`  meeting url        : ${booking.meetingUrl || "(none returned)"}`);
  console.log(`  appointment row    : ${saved?.id || "(not saved)"}`);
  console.log(`  test account       : ${email} (left in place for inspection)`);
}
if (bad.length) {
  console.log("\nFailures:");
  for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
}
process.exit(bad.length ? 1 : 0);

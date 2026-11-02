/**
 * Read-only: asks Cal.com what slots the configured event type actually
 * offers. Prints times only - never the API key.
 *
 *   node scripts/cal-slots-probe.mjs
 */
import "dotenv/config";
import { getCalConfigData, fetchCalSlots, isCalConfigured } from "../dist/lib/cal.js";

function mask(v) {
  return v ? `[${String(v).length} chars]` : "(unset)";
}

console.log("\nCal.com configuration (values never printed):");
console.log(`  configured     : ${isCalConfigured()}`);
console.log(`  CAL_API_KEY    : ${mask(process.env.CAL_API_KEY)}`);
console.log(`  CAL_EVENT_TYPE_ID: ${process.env.CAL_EVENT_TYPE_ID || "(unset)"}`);
console.log(`  CAL_USERNAME   : ${process.env.CAL_USERNAME || "(unset)"}`);
console.log(`  CAL_API_URL    : ${process.env.CAL_API_URL || "(unset)"}`);

const cfg = getCalConfigData();
console.log(`  server sees    : configured=${cfg.configured} eventTypeId=${cfg.eventTypeId ?? "-"}`);

if (!isCalConfigured() || !cfg.eventTypeId) {
  console.log("\nNot enough configuration to query slots.");
  process.exit(0);
}

const from = new Date();
const to = new Date();
to.setDate(to.getDate() + 14);

console.log(`\nQuerying availability ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)} (14 days)`);

try {
  const res = await fetchCalSlots(from.toISOString(), to.toISOString());
  const slots = res?.slots || {};
  const dates = Object.keys(slots).sort();
  console.log(`\nDates with availability: ${dates.length}`);

  let total = 0;
  const all = [];
  for (const d of dates) {
    for (const s of slots[d]) {
      const t = typeof s === "string" ? s : s?.time;
      if (!t) continue;
      total++;
      const dt = new Date(t);
      all.push({
        day: dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
        time: dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        iso: t,
      });
    }
  }

  console.log(`Total slots returned: ${total}`);
  if (total === 0) {
    console.log("\nNO slots - the event type has no availability in the next 14 days.");
    console.log("Causes to check in Cal.com: weekly hours, date range, minimum notice,");
    console.log("buffer times, seat/limit, timezone, or a past event date.");
    process.exit(0);
  }

  // How many would the app show? (it slices the first 5)
  console.log(`\nApp currently shows only the first 5 -> slice(0, 5)`);
  for (const s of all.slice(0, 5)) console.log(`   [shown] ${s.day} ${s.time}`);
  if (all.length > 5) console.log(`   ...and ${all.length - 5} more are fetched but DISCARDED`);

  // Per-day spread: is it a 9-5 workday or a narrow window?
  const byDay = new Map();
  for (const s of all) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s.time);
  }
  console.log("\nPer-day availability:");
  for (const [day, times] of [...byDay.entries()].slice(0, 7)) {
    console.log(`  ${day}: ${times.length} slot(s) -> ${times.join(", ")}`);
  }

  const hours = [...new Set(all.map((s) => s.iso.slice(11, 13)))].sort();
  console.log(`\nDistinct start hours (UTC): ${hours.join(", ")}`);
} catch (e) {
  console.log(`\nFAILED to query Cal.com: code=${e.code || "?"} status=${e.status || "?"}`);
  console.log("Message (no credentials included):", String(e.message || e).slice(0, 200));
  process.exit(1);
}

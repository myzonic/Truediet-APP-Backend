/** Read-only: list production slots that render as 11:00 AM in local time. */
const BASE = "https://api.true-diet.com";

async function get(path) {
  const r = await fetch(BASE + path);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, data: j };
}

const cfg = await get("/api/cal/config");
console.log("config:", cfg.status, JSON.stringify(cfg.data));

const from = new Date().toISOString();
const to = new Date(Date.now() + 14 * 86400000).toISOString();
const et = cfg.data?.eventTypeId;
const slots = await get(
  `/api/cal/slots?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}&eventTypeId=${et}`
);
if (slots.status !== 200) {
  console.log("slots failed:", slots.status, JSON.stringify(slots.data));
  process.exit(1);
}

const flat = [];
for (const [date, list] of Object.entries(slots.data?.slots || {})) {
  for (const item of list || []) {
    const iso = typeof item === "string" ? item : item?.time;
    if (iso) flat.push(iso);
  }
}
flat.sort();
console.log(`total slots: ${flat.length}`);
console.log(`local tz: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

const label = (iso) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const localDate = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const at11 = flat.filter((iso) => label(iso) === "11:00 AM");
console.log(`\nslots rendering as 11:00 AM local: ${at11.length}`);
for (const iso of at11) console.log(`  ${iso}  ->  ${localDate(iso)} ${label(iso)}`);

console.log("\nfirst 8 slots overall:");
for (const iso of flat.slice(0, 8)) console.log(`  ${iso}  ->  ${localDate(iso)} ${label(iso)}`);

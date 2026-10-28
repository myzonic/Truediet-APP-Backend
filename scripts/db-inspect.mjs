import pg from "pg";

const url =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";
const pool = new pg.Pool({ connectionString: url });

const tables = [
  "user",
  "session",
  "account",
  "verification",
  "profile",
  "content",
  "saved_items",
  "message_threads",
  "messages",
  "plans",
  "subscriptions",
  "entitlements",
  "preferences",
  "meal_logs",
  "hunger_checkins",
  "push_tokens",
];

const res = await pool.query(
  `select table_name, column_name, data_type
     from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position`,
);
const byTable = new Map();
for (const row of res.rows) {
  if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
  byTable.get(row.table_name).push(`${row.column_name}:${row.data_type}`);
}

console.log("=== TABLES ===");
for (const t of [...tables, ...byTable.keys()].filter((v, i, a) => a.indexOf(v) === i)) {
  const cols = byTable.get(t);
  if (!cols) {
    console.log(`${t}: MISSING`);
    continue;
  }
  console.log(`${t}: ${cols.join(", ")}`);
}

console.log("\n=== ROW COUNTS ===");
for (const [t] of byTable) {
  try {
    const c = await pool.query(`select count(*)::int as n from "${t}"`);
    console.log(`${t}: ${c.rows[0].n}`);
  } catch (e) {
    console.log(`${t}: ERROR ${e.message}`);
  }
}

await pool.end();

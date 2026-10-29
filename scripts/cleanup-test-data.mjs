import pg from "pg";

const url =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";
const pool = new pg.Pool({ connectionString: url });

const deleted = await pool.query(
  `delete from "user" where email like 'db-verify-%@truediet.test'
                      or email like 'client-sync-%@truediet.test'
                      or email like 'remote-check-%@truediet.test'
                      or email like 'tools-verify-%@truediet.test'
                      or email like 'iso-%@t.test'
                      or email like 'flow-%@truediet.test'
                      or email like 'rl-%@truediet.test'`
);
console.log("deleted test users:", deleted.rowCount);

const tables = [
  "profile",
  "meal_logs",
  "hunger_checkins",
  "saved_items",
  "message_threads",
  "messages",
  "preferences",
  "push_tokens",
  "content",
  "plans",
  "subscriptions",
  "entitlements",
];
for (const t of tables) {
  const r = await pool.query(`select count(*)::int as n from "${t}"`);
  console.log(`${t}: ${r.rows[0].n}`);
}

// Remove content rows created on demand by the save tests.
const orphan = await pool.query(
  `delete from content where slug like 'nb-client-%' or slug like 'nb-verify-%'`
);
console.log("deleted test content:", orphan.rowCount);

await pool.end();

/**
 * Read-only inspection: shows leftover accounts and content rows so nothing
 * real is deleted by accident.
 *
 *   node scripts/db-inspect-leftovers.mjs
 */
import pg from "pg";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";
const pool = new pg.Pool({ connectionString: url });

console.log("=== accounts ===");
const users = await pool.query(
  'select id, email, name, created_at from "user" order by created_at'
);
for (const u of users.rows) {
  const ownedRows = await pool.query(
    `select
        (select count(*) from profile where user_id = $1)          as profile,
        (select count(*) from meal_logs where user_id = $1)        as meals,
        (select count(*) from saved_items where user_id = $1)      as saved,
        (select count(*) from message_threads where user_id = $1)  as threads,
        (select count(*) from appointments where user_id = $1)     as appointments,
        (select count(*) from registrations where user_id = $1)    as registrations`,
    [u.id]
  );
  const c = ownedRows.rows[0];
  const owned =
    Number(c.profile) + Number(c.meals) + Number(c.saved) + Number(c.threads) +
    Number(c.appointments) + Number(c.registrations);
  console.log(`- ${u.email}  (name: ${u.name})`);
  console.log(`    created ${u.created_at.toISOString()}`);
  console.log(`    owned rows: ${owned} -> profile=${c.profile} meals=${c.meals} saved=${c.saved} threads=${c.threads} appts=${c.appointments} regs=${c.registrations}`);
}

console.log("\n=== content rows not matching the canonical seed ===");
const junk = await pool.query(
  `select id, slug, type, title from content
    where slug not like 'article-%'
      and slug not like 'topic-%'
      and slug not like 'myth-%'
      and slug not like 'recipe-%'
      and slug not like 'resource-%'
      and slug not like 'webinar-%'
      and slug not like 'podcast-%'
    order by slug`
);
if (junk.rows.length === 0) console.log("(none)");
for (const row of junk.rows) {
  const refs = await pool.query("select count(*)::int n from saved_items where content_id = $1", [row.id]);
  console.log(`- ${row.slug}  [${row.type}] "${row.title}" (saved by ${refs.rows[0].n} user(s))`);
}

console.log("\n=== meal_logs not owned by a test account ===");
const meals = await pool.query(
  `select m.id, m.description, m.meal_type, m.logged_at, u.email
     from meal_logs m join "user" u on u.id = m.user_id
    order by m.logged_at desc limit 10`
);
if (meals.rows.length === 0) console.log("(none)");
for (const m of meals.rows) {
  console.log(`- [${m.email}] ${m.meal_type}: ${m.description.slice(0, 60)}  (${m.logged_at.toISOString()})`);
}

await pool.end();

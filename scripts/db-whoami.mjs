/**
 * Reports which PostgreSQL database the backend is actually connected to.
 * Prints no passwords.
 *
 *   node scripts/db-whoami.mjs
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

function envOf(name, file) {
  try {
    const raw = fs.readFileSync(path.resolve(file), "utf8");
    const m = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const fromEnv = process.env.DATABASE_URL || envOf("DATABASE_URL", ".env");
const masked = fromEnv.replace(/:[^:@/]+@/, ":****@");

console.log("DATABASE_URL (masked) :", masked || "(not set)");

const pool = new pg.Pool({ connectionString: fromEnv, connectionTimeoutMillis: 10000 });

try {
  const id = await pool.query(
    "select current_database() db, current_user usr, coalesce(inet_server_addr()::text,'local-socket') host, coalesce(inet_server_port(),0) port, version() ver"
  );
  const r = id.rows[0];
  console.log("connected database    :", r.db);
  console.log("role                 :", r.usr);
  console.log("server host           :", r.host, ":" + r.port);
  console.log("server version        :", String(r.ver).split(" ").slice(0, 2).join(" "));

  const t = await pool.query(
    "select count(*)::int n from information_schema.tables where table_schema = 'public'"
  );
  console.log("public tables         :", t.rows[0].n);

  const counts = await pool.query(
    `select
        (select count(*) from "user")            as users,
        (select count(*) from profile)           as profiles,
        (select count(*) from meal_logs)         as meals,
        (select count(*) from hunger_checkins)   as checkins,
        (select count(*) from saved_items)       as saved,
        (select count(*) from message_threads)   as threads,
        (select count(*) from messages)          as messages,
        (select count(*) from content)           as content,
        (select count(*) from plans)             as plans,
        (select count(*) from preferences)       as preferences,
        (select count(*) from appointments)      as appointments,
        (select count(*) from registrations)     as registrations`
  );
  const c = counts.rows[0];
  console.log("\nrow counts:");
  for (const [k, v] of Object.entries(c)) {
    console.log(`  ${k.padEnd(15)}: ${v}`);
  }

  const j = await pool.query(
    "select count(*)::int n from drizzle.__drizzle_migrations"
  ).catch(() => ({ rows: [{ n: null }] }));
  console.log("migration journal rows:", j.rows[0].n, "(drizzle schema)");

  await pool.end();
} catch (e) {
  console.log("ERROR:", e.message);
  await pool.end().catch(() => undefined);
  process.exit(1);
}

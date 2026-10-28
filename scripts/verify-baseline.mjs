/**
 * Verifies the production baseline path against a simulated production
 * database. Operates only on a local throwaway database (tddb_base).
 *
 *   node scripts/verify-baseline.mjs
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";

const ADMIN_URL =
  process.env.LOCAL_ADMIN_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const SIM_DB = "tddb_base";
const SIM_URL = `postgresql://postgres:postgres@127.0.0.1:5432/${SIM_DB}`;
const MIGRATIONS = path.resolve("src/db/migrations");

const admin = new pg.Pool({ connectionString: ADMIN_URL });
const log = (...a) => console.log(...a);

await admin.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SIM_DB}'`
);
await admin.query(`drop database if exists ${SIM_DB}`);
await admin.query(`create database ${SIM_DB}`);

const pool = new pg.Pool({ connectionString: SIM_URL });
const db = drizzle(pool);

// Apply ONLY 0000, exactly like production, and do NOT create a journal.
const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
const first = journal.entries[0];
for (const stmt of fs
  .readFileSync(path.join(MIGRATIONS, `${first.tag}.sql`), "utf8")
  .split("--> statement-breakpoint")) {
  if (stmt.trim()) await pool.query(stmt);
}

const listTables = async () =>
  (await pool.query(
    `select table_name from information_schema.tables where table_schema='public' order by table_name`
  )).rows.map((r) => r.table_name);

log("Simulated production: 0000 tables only, no journal.");
log(`  tables: ${(await listTables()).join(", ")}\n`);

// Import the real baseline module against this database.
process.env.DATABASE_URL = SIM_URL;
const { ensureMigrationBaseline } = await import("../dist/db/baseline.js");

log("=== ensureMigrationBaseline() ===");
await ensureMigrationBaseline(MIGRATIONS);

const jrows = await pool.query("select id, hash, created_at from drizzle.__drizzle_migrations");
log(`  journal rows: ${jrows.rows.length} -> created_at=${JSON.stringify(jrows.rows.map((r) => r.created_at))}`);
log(`  tables now: ${(await listTables()).join(", ")}\n`);

log("=== migrate() after baseline ===");
try {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  log("  migrate() SUCCEEDED");
} catch (e) {
  log(`  migrate() FAILED: ${e.code || ""} ${e.message}`);
}
const tables = await listTables();
log(`  tables now: ${tables.join(", ")}`);
const required = [
  "content","saved_items","entitlements","messages","message_threads","plans",
  "subscriptions","preferences","hunger_checkins","meal_logs","push_tokens",
];
const missing = required.filter((t) => !tables.includes(t));
log(`  missing tables: ${missing.length ? missing.join(", ") : "NONE"}`);

// Verify existing data was preserved (insert a row into the 0000 tables first).
log("\n=== data preservation check ===");
await pool.query(
  `insert into "user" (id, name, email, email_verified, created_at, updated_at)
   values ('keepme', 'Keep Me', 'keepme@test.local', false, now(), now())`
);
await ensureMigrationBaseline(MIGRATIONS);
await migrate(db, { migrationsFolder: MIGRATIONS });
const kept = await pool.query(`select count(*)::int as n from "user" where id = 'keepme'`);
log(`  pre-existing user row still present: ${kept.rows[0].n === 1}`);
const j2 = await pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
log(`  journal rows after re-run: ${j2.rows[0].n}`);

log("\n=== cleanup ===");
await pool.end();
try {
  const { pool: dbPool } = await import("../dist/db/index.js");
  await dbPool.end();
} catch {}
await admin.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SIM_DB}'`
);
await admin.query(`drop database if exists ${SIM_DB}`);
await admin.end();
log("done.");
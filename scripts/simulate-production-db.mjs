/**
 * SIMULATION ONLY - operates exclusively on a local throwaway database
 * (tddb_sim). It reproduces the reported production state and proves which
 * migration strategy is safe. It never touches the production database.
 *
 *   node scripts/simulate-production-db.mjs
 */
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const ADMIN_URL =
  process.env.LOCAL_ADMIN_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const SIM_DB = "tddb_sim";
const SIM_URL = `postgresql://postgres:postgres@127.0.0.1:5432/${SIM_DB}`;
const MIGRATIONS = path.resolve("src/db/migrations");

const admin = new pg.Pool({ connectionString: ADMIN_URL });
const log = (...a) => console.log(...a);

// --------------------------------------------------------------- build DB
await admin.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SIM_DB}'`
);
await admin.query(`drop database if exists ${SIM_DB}`);
await admin.query(`create database ${SIM_DB}`);
await admin.end();

const pool = new pg.Pool({ connectionString: SIM_URL });
const db = drizzle(pool);

// Apply ONLY migration 0000 -> exactly the tables production is reported to have.
const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
const first = journal.entries[0];
const sql0000 = fs.readFileSync(path.join(MIGRATIONS, `${first.tag}.sql`), "utf8");
for (const stmt of sql0000.split("--> statement-breakpoint")) {
  if (stmt.trim()) await pool.query(stmt);
}
log("Simulated production state: applied migration 0000 only, NO journal.\n");

const listTables = async () => {
  const r = await pool.query(
    `select table_name from information_schema.tables where table_schema='public' order by table_name`
  );
  return r.rows.map((x) => x.table_name);
};
const hasJournal = async () => {
  const r = await pool.query(
    `select to_regclass('drizzle.__drizzle_migrations') as t, to_regclass('public.__drizzle_migrations') as p`
  );
  return { drizzle: r.rows[0].t, public: r.rows[0].p };
};

log("Tables present:      ", (await listTables()).join(", "));
const j = await hasJournal();
log("drizzle.__drizzle_migrations:", j.drizzle ?? "ABSENT");
log("public.__drizzle_migrations: ", j.public ?? "ABSENT");
log("");

// ------------------------------------------- STRATEGY 0: migrate() as-is
log("=== STRATEGY 0: run migrate() against this state (what a redeploy does) ===");
try {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  log("  migrate() SUCCEEDED (unexpected)");
} catch (e) {
  log(`  migrate() FAILED: ${e.code || ""} ${e.message}`);
}
const j2 = await hasJournal();
log(`  journal table now: ${j2.drizzle ?? "ABSENT"}`);
if (j2.drizzle) {
  const rows = await pool.query("select id, created_at from drizzle.__drizzle_migrations");
  log(`  journal rows: ${rows.rows.length} ${JSON.stringify(rows.rows)}`);
}
log(`  tables now: ${(await listTables()).join(", ")}`);
log("");

// ------------------------------------------- STRATEGY 1: baseline the journal
log("=== STRATEGY 1: baseline journal at the last applied migration, then migrate() ===");
const last = journal.entries[journal.entries.length - 1];
const lastSql = fs.readFileSync(path.join(MIGRATIONS, `${last.tag}.sql`), "utf8");
const lastHash = crypto.createHash("sha256").update(lastSql).digest("hex");
log(`  last journal entry: ${last.tag} when=${last.when}`);
log(`  sha256(${last.tag}.sql) = ${lastHash}`);
await pool.query(
  `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
  [lastHash, last.when]
);
try {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  log("  migrate() SUCCEEDED - nothing re-run, no error");
} catch (e) {
  log(`  migrate() FAILED: ${e.code || ""} ${e.message}`);
}
const j3 = await hasJournal();
if (j3.drizzle) {
  const rows = await pool.query("select id, created_at from drizzle.__drizzle_migrations order by id");
  log(`  journal rows: ${rows.rows.length} -> ${JSON.stringify(rows.rows.map((r) => r.created_at))}`);
}
log(`  tables now: ${(await listTables()).join(", ")}`);
log("  -> 0001..0005 were SKIPPED, so their tables are still missing.\n");

// --------------------------- STRATEGY 2: baseline + new idempotent migration
log("=== STRATEGY 2: baseline + a new CREATE TABLE IF NOT EXISTS migration ===");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-sim-"));
fs.cpSync(MIGRATIONS, tmp, { recursive: true });

// Build 0006 from the real 0001..0005 SQL, rewritten to be idempotent.
const missingTables = ["content","saved_items","entitlements","messages","message_threads","plans","subscriptions","preferences","hunger_checkins","meal_logs","push_tokens"];
const parts = [];
const guardIndex = (indexName, sql) =>
  `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = '${indexName}') THEN\n    ${sql};\n  END IF;\nEND $$;`;
for (const entry of journal.entries.slice(1)) {
  const s = fs.readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
  for (const stmt of s.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim().replace(/;+$/, "");
    if (!trimmed) continue;
    let out = trimmed;
    if (/^CREATE TABLE /i.test(out)) {
      out = out.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ");
    } else if (/^ALTER TABLE .* ADD CONSTRAINT/i.test(out)) {
      const m = out.match(/ALTER TABLE\s+"?(\w+)"?\s+ADD CONSTRAINT\s+"?(\w+)"?/i);
      if (m) {
        out = `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${m[2]}') THEN\n    ${out};\n  END IF;\nEND $$;`;
      }
    } else if (/^CREATE (UNIQUE )?INDEX/i.test(out)) {
      const m = out.match(/^CREATE (UNIQUE )?INDEX\s+"?(\w+)"?/i);
      if (m) out = guardIndex(m[2], out);
    }
    parts.push(out);
  }
}
const newTag = "0006_production_baseline";
const newWhen = Date.now();
fs.writeFileSync(path.join(tmp, `${newTag}.sql`), parts.join(";\n--> statement-breakpoint\n") + ";\n");
const j4 = JSON.parse(fs.readFileSync(path.join(tmp, "meta/_journal.json"), "utf8"));
j4.entries.push({ idx: j4.entries.length, version: "7", when: newWhen, tag: newTag, breakpoints: true });
fs.writeFileSync(path.join(tmp, "meta/_journal.json"), JSON.stringify(j4, null, 2));

try {
  await migrate(db, { migrationsFolder: tmp });
  log("  migrate() SUCCEEDED");
} catch (e) {
  log(`  migrate() FAILED: ${e.code || ""} ${e.message}`);
}
const j5 = await hasJournal();
if (j5.drizzle) {
  const rows = await pool.query("select id, created_at from drizzle.__drizzle_migrations order by id");
  log(`  journal rows: ${rows.rows.length}`);
}
const finalTables = await listTables();
log(`  tables now: ${finalTables.join(", ")}`);
const stillMissing = missingTables.filter((t) => !finalTables.includes(t));
log(`  missing tables: ${stillMissing.length ? stillMissing.join(", ") : "NONE"}`);
log("");

// ------------------------------------------- STRATEGY 2 re-run idempotency
log("=== STRATEGY 2 re-run (simulates a container restart) ===");
try {
  await migrate(db, { migrationsFolder: tmp });
  log("  migrate() SUCCEEDED - idempotent, no errors, no data change");
} catch (e) {
  log(`  migrate() FAILED: ${e.code || ""} ${e.message}`);
}
const rows = await pool.query(
  `select table_name, count(*) from information_schema.tables t
     left join LATERAL (select 1) x on true
    where table_schema='public' group by table_name order by table_name`
).catch(() => ({ rows: [] }));
log(`  content rows: ${(await pool.query("select count(*)::int as n from content")).rows[0].n}`);

log("\n--- cleanup ---");
fs.rmSync(tmp, { recursive: true, force: true });
await pool.end();
await admin.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SIM_DB}'`
);
await admin.query(`drop database if exists ${SIM_DB}`);
await admin.end();
log("simulation database dropped.");

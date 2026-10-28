import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./index.js";

/**
 * Tables created by the first migration (0000). These are the Better Auth
 * tables plus `profile`. A production database that already has them was
 * provisioned before the drizzle journal existed.
 */
const BASELINE_TABLES = ["user", "account", "session", "verification", "profile"];

/**
 * Reconciles a database whose drizzle journal is missing or empty.
 *
 * Drizzle decides which migrations to run by reading the single newest row
 * from `drizzle.__drizzle_migrations` and comparing its `created_at` against
 * each migration's journal timestamp. If that table is empty, drizzle believes
 * no migration has ever run and re-runs 0000, which fails with
 * `42P07 relation "account" already exists` and rolls the whole run back.
 *
 * When the database already contains the 0000 tables but has no journal row,
 * we record the already-applied state so the migrator skips 0000 and only
 * applies the migrations that are genuinely missing. Nothing is dropped,
 * altered or deleted - this only ever inserts a bookkeeping row.
 *
 * @param migrationsFolder absolute path to the migrations directory
 */
export async function ensureMigrationBaseline(migrationsFolder: string): Promise<void> {
  const journalPath = path.join(migrationsFolder, "meta/_journal.json");
  if (!fs.existsSync(journalPath)) {
    console.warn("No migration journal found; skipping baseline check.");
    return;
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = journal.entries ?? [];
  if (!entries.length) return;

  const journalRows = await db.execute(sql`
    select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
  `).catch(() => null);

  const current = (journalRows as any)?.rows?.[0];
  if (current) {
    // A journal row already exists - drizzle knows what to do.
    return;
  }

  // No journal row. Check whether the baseline tables are already present.
  const existing = await db.execute(sql`
    select count(*)::int as n
      from information_schema.tables
     where table_schema = 'public'
       and table_name in (${sql.join(BASELINE_TABLES.map((t) => sql`${t}`), sql`, `)})
  `).catch(() => null);

  const present = Number((existing as any)?.rows?.[0]?.n ?? 0);
  if (present < BASELINE_TABLES.length) {
    // Nothing to baseline - this is a fresh database. Let drizzle run 0000.
    console.log("No existing tables detected - migrations will run from the beginning.");
    return;
  }

  // Find the newest migration whose tables are all present, and record it as
  // applied. Drizzle only ever looks at the newest row, so a single row for
  // the newest fully-applied migration is enough.
  const applied: string[] = [];
  let newest: { entry: any; hash: string } | null = null;

  for (const entry of entries) {
    const file = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(file)) continue;
    const sqlText = fs.readFileSync(file, "utf8");
    const hash = crypto.createHash("sha256").update(sqlText).digest("hex");

    const tables = [...sqlText.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)].map(
      (m) => m[1]
    );
    const required = tables.filter((t) => !BASELINE_TABLES.includes(t));

    if (required.length === 0) {
      // The first migration's tables are the baseline itself.
      applied.push(entry.tag);
      newest = { entry, hash };
      continue;
    }

    const found = await db.execute(sql`
      select count(*)::int as n
        from information_schema.tables
       where table_schema = 'public'
         and table_name in (${sql.join(required.map((t) => sql`${t}`), sql`, `)})
    `).catch(() => null);
    const count = Number((found as any)?.rows?.[0]?.n ?? 0);

    if (count === required.length) {
      // Fully applied.
      applied.push(entry.tag);
      newest = { entry, hash };
    } else if (count > 0) {
      // Partially applied (only possible if the schema was provisioned by
      // hand or by `drizzle-kit push` and interrupted). The final baseline
      // migration recreates any missing table with CREATE TABLE IF NOT
      // EXISTS, so it is safe to skip this migration here.
      applied.push(`${entry.tag} (partial)`);
      newest = { entry, hash };
    } else {
      // Not applied - stop here and let drizzle run it normally.
      break;
    }
  }

  if (!newest) {
    console.warn("Could not determine a migration baseline; leaving the journal untouched.");
    return;
  }

  const { entry, hash } = newest;

  // The journal table is created by drizzle's migrator. When the journal is
  // missing entirely we have to create it ourselves before we can write the
  // baseline row. This mirrors the exact definition drizzle uses.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  await db.execute(sql`
    insert into drizzle.__drizzle_migrations (hash, created_at)
    values (${hash}, ${entry.when})
  `);

  console.log(
    `Baseline recorded: ${entry.tag} (${applied.join(", ")}) - existing tables were adopted without re-running migrations.`
  );
}

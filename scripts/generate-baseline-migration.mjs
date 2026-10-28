/**
 * Generates the idempotent SQL for migration 0006_production_baseline.
 *
 * Production already contains the tables created by migration 0000
 * (user, account, session, verification, profile) but its drizzle journal
 * was never populated, so a plain `migrate()` would try to re-run 0000 and
 * abort on `42P07 relation "account" already exists`.
 *
 * 0006 re-creates every table from 0001..0005 using CREATE TABLE IF NOT
 * EXISTS and guarded constraints/indexes, so it is safe to run against a
 * database that already has some or all of them, and safe to re-run.
 *
 *   node scripts/generate-baseline-migration.mjs
 */
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve("src/db/migrations");
const TARGET = process.argv[2] || path.join(MIGRATIONS, "0006_production_baseline.sql");

const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
// Reproduces migrations 0001..0005 idempotently, so the baseline file can
// create any table that is still missing. Later migrations (0006 onwards)
// stay responsible for their own objects.
const entries = journal.entries.filter(
  (e) => e.idx > 0 && e.idx <= 5 && e.tag !== "0006_production_baseline"
);

const out = [];
out.push("-- Production baseline migration.");
out.push("--");
out.push("-- Production already has the 0000 tables (user, account, session,");
out.push("-- verification, profile) but an empty drizzle journal, so `migrate()` would");
out.push("-- re-run 0000 and abort with 42P07. The server baselines the journal");
out.push("-- before migrating; this file then creates any table from 0001..0005 that");
out.push("-- is still missing, using IF NOT EXISTS and guarded constraints so it is");
out.push("-- safe to run repeatedly and never drops or alters existing data.");
out.push("");

for (const entry of entries) {
  const raw = fs.readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
  out.push(`-- ---------------------------------------------------------------- ${entry.tag}`);
  for (const stmt of raw.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim().replace(/;+$/, "");
    if (!trimmed) continue;

    let sql = trimmed;
    if (/^CREATE TABLE /i.test(sql)) {
      sql = sql.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ");
    } else if (/^ALTER TABLE .* ADD CONSTRAINT/i.test(sql)) {
      const m = sql.match(/ALTER TABLE\s+"?([\w]+)"?\s+ADD CONSTRAINT\s+"?([\w]+)"?/i);
      if (m) {
        sql =
          `DO $$\n` +
          `BEGIN\n` +
          `  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${m[2]}') THEN\n` +
          `    ${sql};\n` +
          `  END IF;\n` +
          `END $$;`;
      }
    } else if (/^CREATE (UNIQUE )?INDEX/i.test(sql)) {
      const m = sql.match(/^CREATE (UNIQUE )?INDEX\s+"?([\w]+)"?/i);
      if (m) {
        sql =
          `DO $$\n` +
          `BEGIN\n` +
          `  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${m[2]}') THEN\n` +
          `    ${sql};\n` +
          `  END IF;\n` +
          `END $$;`;
      }
    }
    out.push(sql + ";");
    out.push("--> statement-breakpoint");
  }
  out.push("");
}

// Remove the trailing marker so the file ends cleanly.
while (out.length && out[out.length - 1] === "") out.pop();
if (out[out.length - 1] === "--> statement-breakpoint") out.pop();
out.push("");

fs.writeFileSync(TARGET, out.join("\n"));
console.log(`Wrote ${TARGET}`);
console.log(`Statements: ${out.filter((l) => l.endsWith(";")).length}`);

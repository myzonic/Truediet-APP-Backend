/**
 * Verifies the content-seed reconcile never destroys a member's saved link.
 *
 *   node scripts/db-verify-seed-reconcile.mjs   (run after: npm run build)
 *
 * Creates a throwaway account + saved item, runs seedContent(), and confirms
 * the saved link still joins to valid content. Cleans up afterwards.
 */
import pg from "pg";
import { pathToFileURL } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";
const pool = new pg.Pool({ connectionString: url });

const USER_ID = "probe-seed-reconcile";
const EMAIL = "probe-seed-reconcile@truediet.test";
const TARGET_SLUG = "recipe-overnight-oats";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  PASS " : "  FAIL "} ${label}${detail ? " - " + detail : ""}`);
  if (!ok) failures++;
};

try {
  // 1. Ensure a throwaway account exists.
  await pool.query(
    `insert into "user" (id, name, email) values ($1, $2, $3)
     on conflict (id) do nothing`,
    [USER_ID, "Seed Reconcile Probe", EMAIL]
  );

  // 2. Pick a canonical content row and save it as this account.
  const target = await pool.query(`select id from content where slug = $1 limit 1`, [TARGET_SLUG]);
  if (target.rows.length === 0) {
    console.log(`  SKIP target slug ${TARGET_SLUG} not present`);
    await pool.end();
    process.exit(0);
  }
  const contentId = target.rows[0].id;

  await pool.query(`delete from saved_items where user_id = $1`, [USER_ID]);
  await pool.query(`insert into saved_items (user_id, content_id) values ($1, $2)`, [
    USER_ID,
    contentId,
  ]);

  const before = await pool.query(
    `select count(*)::int n from saved_items where user_id = $1`,
    [USER_ID]
  );
  const beforeContent = await pool.query(`select count(*)::int n from content`);
  check(before.rows[0].n === 1, "saved item created", `${before.rows[0].n} row`);

  // 3. Run the seed, which upserts and reconciles duplicates.
  const seedMod = await import(pathToFileURL(path.resolve("src/db/seed.ts")).href);
  await seedMod.seedContent();

  const afterContent = await pool.query(`select count(*)::int n from content`);
  check(
    afterContent.rows[0].n === beforeContent.rows[0].n,
    "content row count unchanged by re-seed",
    `${beforeContent.rows[0].n} -> ${afterContent.rows[0].n}`
  );

  // 4. The saved link must still join to real content.
  const after = await pool.query(
    `select count(*)::int n
       from saved_items s
       join content c on c.id = s.content_id
      where s.user_id = $1`,
    [USER_ID]
  );
  check(after.rows[0].n === 1, "saved link survived reconcile", `${after.rows[0].n} row`);

  // 5. And it must point at the canonical row, not an orphan.
  const canonical = await pool.query(
    `select s.content_id = $1 as ok
       from saved_items s where s.user_id = $2`,
    [contentId, USER_ID]
  );
  check(canonical.rows[0]?.ok === true, "saved link still points at canonical content");

  // 6. No duplicate titles remain (the reconcile's whole purpose).
  const dupes = await pool.query(
    `select title, count(*)::int n from content
      where type in ('article','myth','recipe','resource','class','webinar','podcast','topic')
      group by title having count(*) > 1`
  );
  check(
    dupes.rows.length === 0,
    "no duplicate titles in the library",
    dupes.rows.length ? dupes.rows.map((d) => d.title).join(" | ") : `${dupes.rows.length}`
  );

  // 7. Content count matches the generated seed exactly.
  const seedMod2 = await import(pathToFileURL(path.resolve("src/db/content-seed.generated.ts")).href);
  const seedCount = (seedMod2.contentSeed || []).length;
  check(
    afterContent.rows[0].n === seedCount,
    "content rows match generated seed",
    `db=${afterContent.rows[0].n} seed=${seedCount}`
  );
} catch (e) {
  console.log(`  FAIL unexpected error - ${e.message}`);
  failures++;
} finally {
  // Cleanup the probe account (cascade removes saved_items).
  try {
    await pool.query(`delete from saved_items where user_id = $1`, [USER_ID]);
    await pool.query(`delete from "user" where id = $1`, [USER_ID]);
    const left = await pool.query(`select count(*)::int n from "user" where id = $1`, [USER_ID]);
    console.log(`  ${left.rows[0].n === 0 ? "PASS" : "FAIL"} probe cleaned up`);
    if (left.rows[0].n !== 0) failures++;
  } catch (e) {
    console.log(`  FAIL cleanup - ${e.message}`);
    failures++;
  }
  await pool.end();
}

console.log(failures === 0 ? "\nseed reconcile verified" : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);

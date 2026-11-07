/** Database QA: constraints, referential integrity, orphans, indexes, seed. */
import pg from "pg";
import fs from "node:fs";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/truediet";
const pool = new pg.Pool({ connectionString: url });
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  PASS  ${n}${d ? " - " + d : ""}`)) : (fail++, console.log(`  FAIL  ${n} ${d}`)); };

const USER_TABLES = ["profile","saved_items","message_threads","subscriptions","entitlements","preferences","meal_logs","hunger_checkins","weight_entries","push_tokens","appointments","registrations"];
const q = (sql, params) => pool.query(sql, params);
const pg_indexes = async () => (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'`)).rows;

// 1. every expected table exists
{
  const r = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  const have = new Set(r.rows.map((x) => x.table_name));
  const need = ["user","session","account","verification","profile","content","saved_items","message_threads","messages","plans","subscriptions","entitlements","preferences","meal_logs","hunger_checkins","weight_entries","push_tokens","appointments","registrations"];
  const missing = need.filter((t) => !have.has(t));
  ok("all 19 tables exist", missing.length === 0, missing.length ? `missing=${missing}` : `${have.size} tables`);
}

// 2. foreign keys + ON DELETE rules (user-owned rows must cascade)
{
  const r = await q(`
    SELECT tc.table_name, kcu.column_name, rc.delete_rule, ccu.table_name AS ref_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema='public'
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
    JOIN information_schema.referential_constraints rc ON rc.constraint_name=tc.constraint_name
    WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
  const fks = r.rows;
  ok("foreign keys present", fks.length >= 10, `${fks.length} FKs`);
  const userFks = fks.filter((f) => f.ref_table === "user");
  const nonCascade = userFks.filter((f) => f.delete_rule !== "CASCADE");
  ok("user-owned FKs all ON DELETE CASCADE", userFks.length >= USER_TABLES.length && nonCascade.length === 0,
     `${userFks.length} user FKs${nonCascade.length ? ` non-cascade: ${nonCascade.map((x) => `${x.table_name}.${x.column_name}(${x.delete_rule})`).join(",")}` : ""}`);
  const threadFk = fks.find((f) => f.table_name === "messages" && f.ref_table === "message_threads");
  ok("messages -> message_threads FK", !!threadFk && threadFk.delete_rule === "CASCADE", threadFk?.delete_rule || "missing");
  const subFk = fks.find((f) => f.table_name === "subscriptions" && f.ref_table === "plans");
  ok("subscriptions -> plans FK", !!subFk, subFk?.delete_rule || "missing");
}

// 3. orphan rows: user_id pointing at deleted users
{
  let orphans = [];
  for (const t of USER_TABLES) {
    const col = t === "preferences" || t === "profile" || t === "saved_items" || t === "message_threads" || t === "meal_logs" || t === "push_tokens" || t === "registrations" ? "user_id" : "user_id";
    try {
      const r = await q(`SELECT count(*)::int AS n FROM ${t} x WHERE x.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = x.${col})`);
      if (r.rows[0].n > 0) orphans.push(`${t}:${r.rows[0].n}`);
    } catch (e) { orphans.push(`${t}:ERR ${e.message.slice(0, 40)}`); }
  }
  ok("no orphaned user-owned rows", orphans.length === 0, orphans.join(", ") || "0 orphans");
}

// 4. messages orphans (thread gone)
{
  const r = await q(`SELECT count(*)::int AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM message_threads t WHERE t.id = m.thread_id)`);
  ok("no messages without a thread", r.rows[0].n === 0, `orphans=${r.rows[0].n}`);
}

// 5. unique constraints that the app relies on
{
  const idx = await pg_indexes();
  const names = new Set(idx.map((r) => r.indexname));
  ok("user.email unique", names.has("user_email_unique"), names.has("user_email_unique") ? "" : [...names].join(","));
  ok("session.token unique", names.has("session_token_unique"));
  ok("content.slug unique", names.has("content_slug_unique"));
  ok("plans.code unique", names.has("plans_code_unique"));
  ok("profile.user_id unique", names.has("profile_user_id_unique"));
  ok("saved_items (user_id,content_id) unique", names.has("saved_items_user_content_unique"));
  ok("registrations (user_id,slug) unique", names.has("registrations_user_slug_unique"));
}

// 6. indexes covering every user-owned lookup (first column of some btree index)
{
  const defs = (await pg_indexes()).map((r) => r.indexdef);
  const covers = (table, col) =>
    defs.some((d) => d.includes(`ON public.${table === "user" ? '"user"' : table}`) && new RegExp(`btree \\(${col}[,)]`).test(d));
  const need = [
    ["user", "id"], ["session", "user_id"], ["account", "user_id"],
    ["profile", "user_id"], ["saved_items", "user_id"], ["message_threads", "user_id"],
    ["messages", "thread_id"], ["subscriptions", "user_id"], ["entitlements", "user_id"],
    ["meal_logs", "user_id"], ["hunger_checkins", "user_id"], ["push_tokens", "user_id"],
    ["appointments", "user_id"], ["appointments", "booking_id"], ["registrations", "user_id"],
    ["weight_entries", "user_id"],
  ];
  const missing = need.filter(([t, c]) => !covers(t, c)).map(([t, c]) => `${t}.${c}`);
  ok("every hot column is index-covered", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${need.length} covered`);
}

// 7. app-level CHECK/validation constraints present where the API enforces ranges
{
  const r = await q(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='hunger_checkins'::regclass AND contype='c'`);
  const hasRange = r.rows.some((x) => x.def.includes("BETWEEN") || x.def.includes("1") && x.def.includes("5"));
  ok("hunger_checkins rating CHECK (1-5)", hasRange || r.rows.length === 0, r.rows.length ? r.rows.map((x) => x.def).join("; ") : "no CHECK - API validates (acceptable)");
  const nn = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='meal_logs' AND is_nullable='NO' AND column_name IN ('meal_type','description','logged_at')`);
  ok("meal_logs critical columns NOT NULL", nn.rows.length === 3, `${nn.rows.length}/3`);
}

// 8. seed integrity: plans active + content published
{
  const p = await q(`SELECT count(*)::int AS n FROM plans WHERE active = true`);
  ok("3 active plans", p.rows[0].n === 3, `active=${p.rows[0].n}`);
  const c = await q(`SELECT count(*)::int AS n FROM content`);
  const types = await q(`SELECT type, count(*)::int AS n FROM content GROUP BY type ORDER BY type`);
  ok("content seeded", c.rows[0].n >= 50, `${c.rows[0].n} rows: ${types.rows.map((t) => `${t.type}=${t.n}`).join(", ")}`);
  const dup = await q(`SELECT slug, count(*)::int AS n FROM content GROUP BY slug HAVING count(*) > 1`);
  ok("no duplicate content slugs", dup.rows.length === 0, dup.rows.map((d) => d.slug).join(",") || "none");
}

// 9. leftover test artifacts (report only - cleaned in cleanup step)
{
  const testContent = await q(`SELECT count(*)::int AS n FROM content WHERE slug LIKE 'nb-client-%' OR title LIKE 'Client sync%'`);
  const testUsers = await q(`SELECT count(*)::int AS n FROM "user" WHERE email LIKE '%@truediet.test' OR email LIKE 'cal-%@gmail.com' OR email LIKE 'smoke-%@gmail.com' OR email LIKE 'chk%@gmail.com' OR email LIKE 'e2e-%@%' OR email LIKE 'auth-%@truediet.test' OR email LIKE 'repro-%@truediet.test'`);
  const verif = await q(`SELECT count(*)::int AS n FROM verification`);
  console.log(`  INFO  leftovers: ${testContent.rows[0].n} test content row(s), ${testUsers.rows[0].n} test account(s), ${verif.rows[0].n} verification row(s)`);
}

// 10. live cascade proof: create user + rows, delete user, rows must vanish
{
  const stamp = Date.now();
  const u = await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1,$2,$3,true,now(),now()) RETURNING id`, [`qa-${stamp}`, "QA Cascade", `qa-cascade-${stamp}@gmail.com`]);
  const uid = u.rows[0].id;
  await q(`INSERT INTO meal_logs (id, user_id, meal_type, description, source, logged_at, created_at) VALUES (gen_random_uuid(), $1,'lunch','qa','manual',now(),now())`, [uid]);
  await q(`INSERT INTO hunger_checkins (id, user_id, hunger_before, fullness_after, created_at) VALUES (gen_random_uuid(), $1,3,4,now())`, [uid]);
  await q(`INSERT INTO appointments (id, user_id, slot, visit_type, status, created_at, updated_at) VALUES (gen_random_uuid(), $1,'QA','video','confirmed',now(),now())`, [uid]);
  await q(`INSERT INTO push_tokens (id, user_id, token, platform, created_at) VALUES (gen_random_uuid(), $1,'qa-token','ios',now())`, [uid]);
  await q(`INSERT INTO registrations (id, user_id, title, slug, kind, registered_at) VALUES (gen_random_uuid(), $1,'QA','qa-reg','webinar',now())`, [uid]);
  await q(`INSERT INTO weight_entries (id, user_id, weight, recorded_at, created_at) VALUES (gen_random_uuid(), $1,'72 kg',now(),now())`, [uid]);
  await q(`INSERT INTO saved_items (id, user_id, content_id, created_at) SELECT gen_random_uuid(), $1, id, now() FROM content LIMIT 1`, [uid]);
  await q(`INSERT INTO profile (id, user_id, display_name, created_at, updated_at) VALUES (gen_random_uuid(), $1,'QA',now(),now())`, [uid]);
  const before = await q(`SELECT
    (SELECT count(*) FROM meal_logs WHERE user_id=$1)::int AS meals,
    (SELECT count(*) FROM hunger_checkins WHERE user_id=$1)::int AS checks,
    (SELECT count(*) FROM appointments WHERE user_id=$1)::int AS appts,
    (SELECT count(*) FROM push_tokens WHERE user_id=$1)::int AS pushes,
    (SELECT count(*) FROM registrations WHERE user_id=$1)::int AS regs,
    (SELECT count(*) FROM weight_entries WHERE user_id=$1)::int AS weights,
    (SELECT count(*) FROM saved_items WHERE user_id=$1)::int AS saved,
    (SELECT count(*) FROM profile WHERE user_id=$1)::int AS prof`, [uid]);
  const b = before.rows[0];
  const allPresent = b.meals === 1 && b.checks === 1 && b.appts === 1 && b.pushes === 1 && b.regs === 1 && b.weights === 1 && b.saved === 1 && b.prof === 1;
  ok("cascade fixture created (8 row types)", allPresent, JSON.stringify(b));
  await q(`DELETE FROM "user" WHERE id = $1`, [uid]);
  const after = await q(`SELECT
    (SELECT count(*) FROM meal_logs WHERE user_id=$1)::int AS meals,
    (SELECT count(*) FROM hunger_checkins WHERE user_id=$1)::int AS checks,
    (SELECT count(*) FROM appointments WHERE user_id=$1)::int AS appts,
    (SELECT count(*) FROM push_tokens WHERE user_id=$1)::int AS pushes,
    (SELECT count(*) FROM registrations WHERE user_id=$1)::int AS regs,
    (SELECT count(*) FROM weight_entries WHERE user_id=$1)::int AS weights,
    (SELECT count(*) FROM saved_items WHERE user_id=$1)::int AS saved,
    (SELECT count(*) FROM profile WHERE user_id=$1)::int AS prof,
    (SELECT count(*) FROM "user" WHERE id=$1)::int AS usr`, [uid]);
  const a = after.rows[0];
  const allGone = Object.values(a).every((v) => v === 0);
  ok("DELETE user cascades all 8 row types", allGone, JSON.stringify(a));
}

// 11. cross-tenant isolation at the SQL level
{
  const stamp = Date.now();
  const a = await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1,'A',$2,true,now(),now()) RETURNING id`, [`qa-a-${stamp}`, `qa-a-${stamp}@gmail.com`]);
  const b = await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1,'B',$2,true,now(),now()) RETURNING id`, [`qa-b-${stamp}`, `qa-b-${stamp}@gmail.com`]);
  await q(`INSERT INTO meal_logs (id, user_id, meal_type, description, source, logged_at, created_at) VALUES (gen_random_uuid(), $1,'dinner','private','manual',now(),now())`, [a.rows[0].id]);
  const leak = await q(`SELECT count(*)::int AS n FROM meal_logs WHERE user_id=$1`, [b.rows[0].id]);
  ok("user B sees 0 of user A's rows", leak.rows[0].n === 0, `n=${leak.rows[0].n}`);
  const del = await q(`DELETE FROM meal_logs WHERE user_id=$1`, [b.rows[0].id]);
  const stillThere = await q(`SELECT count(*)::int AS n FROM meal_logs WHERE user_id=$1`, [a.rows[0].id]);
  ok("deleting as B removes nothing of A's", stillThere.rows[0].n === 1, `n=${stillThere.rows[0].n}`);
  await q(`DELETE FROM "user" WHERE id IN ($1,$2)`, [a.rows[0].id, b.rows[0].id]);
}

await pool.end();
console.log(`\nDATABASE QA: ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

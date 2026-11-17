// Validates that every JSON-looking single-quoted SQL literal in the
// migration files is actually valid JSON. A malformed jsonb seed literal
// (e.g. an unescaped inner double quote) aborts startup, so failing fast
// here keeps that class of bug out of production.
//
// Run with: node scripts/validate-migration-json.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations"
);

let invalid = 0;
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  // SQL escapes a quote inside a string by doubling it ('' ).
  const re = /'((?:''|[^'])*)'/g;
  let match;
  while ((match = re.exec(text))) {
    const raw = match[1].replace(/''/g, "'").trim();
    if (!(raw.startsWith("[") || raw.startsWith("{"))) continue;
    try {
      JSON.parse(raw);
    } catch (err) {
      const line = text.slice(0, match.index).split("\n").length;
      invalid++;
      console.error(`${name}:${line} invalid JSON seed: ${err.message}`);
    }
  }
}

if (invalid) {
  console.error(`Found ${invalid} invalid JSON literal(s) in migrations.`);
  process.exit(1);
}
console.log("All migration JSON literals are valid.");

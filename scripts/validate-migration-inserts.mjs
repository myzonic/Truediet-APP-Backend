// Validates that every INSERT ... VALUES tuple has the same number of
// expressions as the target column list. Catches "INSERT has more expressions
// than target columns" errors that otherwise only surface at startup in
// production (and whose real Postgres message Drizzle hides).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

// Split a string on top-level commas, respecting single-quoted SQL strings
// (where '' is an escaped quote) and JSON brackets/quotes.
function splitTopLevel(s) {
  const out = [];
  let depth = 0, inSingle = false, inDouble = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") {
        if (s[i + 1] === "'") { i++; } else { inSingle = false; }
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

let errors = 0;
for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  const re = /INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:ON\s+CONFLICT|;|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const table = m[1];
    const cols = splitTopLevel(m[2]).length;
    const valuesBlock = m[3];
    // Each tuple is ( ... ) at top level.
    const tuples = [];
    let depth = 0, inSingle = false, inDouble = false, start = -1;
    for (let i = 0; i < valuesBlock.length; i++) {
      const c = valuesBlock[i];
      if (inSingle) {
        if (c === "'") { if (valuesBlock[i + 1] === "'") i++; else inSingle = false; }
        continue;
      }
      if (inDouble) {
        if (c === '\\') { i++; continue; }
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === '(') { if (depth === 0) start = i; depth++; }
      else if (c === ')') { depth--; if (depth === 0 && start >= 0) { tuples.push(valuesBlock.slice(start + 1, i)); start = -1; } }
    }
    for (let ti = 0; ti < tuples.length; ti++) {
      const n = splitTopLevel(tuples[ti]).length;
      if (n !== cols) {
        const line = text.slice(0, m.index).split('\n').length;
        errors++;
        console.error(`${name}:${line} ${table}: column list has ${cols} but tuple #${ti + 1} has ${n} values`);
      }
    }
  }
}
if (errors) { console.error(`Found ${errors} INSERT column/value mismatch(es).`); process.exit(1); }
console.log('All INSERT tuples match their column lists.');

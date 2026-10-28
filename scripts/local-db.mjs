/**
 * Starts a local PostgreSQL instance for development.
 *
 * Uses the `embedded-postgres` binaries so no system-wide Postgres, Docker or
 * admin rights are required. Data persists in `server/.pgdata`, so restarting
 * this script does not lose the database.
 *
 *   npm run db:local        # leave running in its own terminal
 *
 * Connection string (kept in sync with server/.env):
 *   postgresql://postgres:postgres@127.0.0.1:5432/truediet
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const here = dirname(fileURLToPath(import.meta.url));
const databaseDir = join(here, '..', '.pgdata');
const port = Number(process.env.LOCAL_PG_PORT) || 5432;
const database = process.env.LOCAL_PG_DATABASE || 'truediet';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
});

// `initialise()` fails on an existing cluster, so only run it on first start.
if (!existsSync(join(databaseDir, 'PG_VERSION'))) {
  console.log(`Initialising PostgreSQL cluster in ${databaseDir} ...`);
  await pg.initialise();
}

await pg.start();

try {
  await pg.createDatabase(database);
  console.log(`Created database "${database}".`);
} catch (error) {
  const message = String(error?.message || error);
  if (!/already exists/i.test(message)) {
    console.error('Could not create database:', message);
    await pg.stop();
    process.exit(1);
  }
  console.log(`Database "${database}" already exists.`);
}

console.log(`PostgreSQL ready on 127.0.0.1:${port} (database: ${database}).`);
console.log('Press Ctrl+C to stop.');

const shutdown = async () => {
  console.log('\nStopping PostgreSQL ...');
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

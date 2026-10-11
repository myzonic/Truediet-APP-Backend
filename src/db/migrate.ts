import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL environment variable is not defined.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });

  const db = drizzle(pool);

  console.log("Applying database migrations...");
  try {
    const migrationsFolder = "./dist/db/migrations";
    const srcFolder = "./src/db/migrations";
    const folder = (await import("fs")).existsSync(migrationsFolder) ? migrationsFolder : srcFolder;
    await migrate(db, { migrationsFolder: folder });
    console.log("Database migrations applied successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();

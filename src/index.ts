import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { auth } from "./lib/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { pool } from "./db/index.js";
import * as dotenv from "dotenv";

dotenv.config();

const app = new Hono();

// Middleware: Structured Logging
app.use("*", logger());

// Middleware: CORS for Mobile & Web clients
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// 1. Health-check endpoint
app.get("/health", async (c) => {
  try {
    // Quick DB ping
    await pool.query("SELECT 1");
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
    });
  } catch (err: any) {
    return c.json(
      {
        status: "degraded",
        timestamp: new Date().toISOString(),
        database: "disconnected",
        error: err.message,
      },
      503
    );
  }
});

// 2. Mount Better Auth Handler on /api/auth/*
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  return auth.handler(c.req.raw);
});

// 3. Mount TrueDiet Profile & Assessment API
app.route("/api/profile", profileRoutes);

// Run database migrations on startup
async function startServer() {
  try {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { db } = await import("./db/index.js");
    const fs = await import("fs");
    const migrationsFolder = fs.existsSync("./dist/db/migrations")
      ? "./dist/db/migrations"
      : "./src/db/migrations";

    console.log(`Checking and applying database migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log("Database migrations verified and up to date!");
  } catch (err: any) {
    console.error("Migration error on startup:", err.message);
  }

  // Server start
  const port = Number(process.env.PORT) || 3000;
  console.log(`Starting TrueDiet backend on port ${port}...`);

  serve({
    fetch: app.fetch,
    port,
  });
}

startServer();


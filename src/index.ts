import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { auth } from "./lib/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { contentRoutes } from "./routes/content.js";
import { savedRoutes } from "./routes/saved.js";
import { messageRoutes } from "./routes/messages.js";
import { subscriptionRoutes } from "./routes/subscription.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { accountRoutes } from "./routes/account.js";
import { trackRoutes } from "./routes/track.js";
import { pushRoutes } from "./routes/push.js";
import { calRoutes } from "./routes/cal.js";
import { streamRoutes } from "./routes/stream.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { registrationRoutes } from "./routes/registrations.js";
import { seedContent } from "./db/seed.js";
import { pool } from "./db/index.js";
import * as dotenv from "dotenv";

dotenv.config();

const app = new Hono();

// Middleware: Structured Logging
app.use("*", logger());

// Global error handler. Unhandled failures (for example a database error)
// return a consistent body instead of Hono's default HTML/500, and the
// underlying cause is logged server-side rather than sent to the client.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, err?.message || err);
  return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
});

// Middleware: CORS for Mobile & Web clients
// The origin allow-list is explicit. Reflecting any origin while sending
// `Access-Control-Allow-Credentials: true` would let a third-party website
// read authenticated API responses.
const allowedOrigins = [
  "http://localhost:8081",
  "http://localhost:19006",
  "http://localhost:3000",
  "exp://*",
  "truediet://*",
  ...(process.env.TRUSTED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.some((allowed) => {
    if (allowed.endsWith("*")) {
      return origin.startsWith(allowed.slice(0, -1));
    }
    return allowed === origin;
  });
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// 1. Health-check endpoint
// The check verifies that the expected tables exist, not just that the
// connection works. A database with a missing table would otherwise report
// "ok" while every endpoint failed.
app.get("/health", async (c) => {
  try {
    await pool.query("SELECT 1");
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('user','account','session','verification','profile','content',
                             'saved_items','message_threads','messages','plans','subscriptions',
                             'entitlements','preferences','meal_logs','hunger_checkins','push_tokens',
                             'appointments','registrations')`
    );
    const tableCount = Number(rows[0]?.n ?? 0);
    const EXPECTED_TABLES = 18;
    if (tableCount < EXPECTED_TABLES) {
      return c.json(
        {
          status: "degraded",
          timestamp: new Date().toISOString(),
          database: "connected",
          schema: "incomplete",
          tablesPresent: tableCount,
          tablesExpected: EXPECTED_TABLES,
          error: "The database schema is missing tables. Apply the baseline migration.",
        },
        503
      );
    }
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
      schema: "complete",
      tablesPresent: tableCount,
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

// 4. Mount Content Library & Saved Items API
app.route("/api/content", contentRoutes);
app.route("/api/saved", savedRoutes);

// 5. Mount Messaging (Ask the Dietitian) and Plans/Subscriptions API
app.route("/api/messages", messageRoutes);
app.route("/api", subscriptionRoutes);

// 6. Mount User Preferences and Account (export / delete) API
app.route("/api/preferences", preferenceRoutes);
app.route("/api/account", accountRoutes);

// 7. Mount Tracking (meals, hunger check-ins, progress) API
// Mounted at /api so the routes land on /api/meals, /api/hunger and
// /api/progress - the exact paths the mobile client calls.
app.route("/api", trackRoutes);

// 8. Mount Push Notification device registration API
app.route("/api/push-tokens", pushRoutes);
// 9. Mount Cal.com scheduling API
app.route("/api/cal", calRoutes);
// 10. Mount GetStream video & phone calling API
app.route("/api/stream", streamRoutes);
// 11. Mount Telehealth appointments API
app.route("/api/appointments", appointmentRoutes);
// 12. Mount Webinar / class registrations API
app.route("/api/registrations", registrationRoutes);

// Run database migrations on startup
async function startServer() {
  try {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { db } = await import("./db/index.js");
    const fs = await import("fs");
    const path = await import("path");
    const url = await import("url");

    // Resolve the migrations folder relative to this module so it does not
    // depend on the process working directory.
    const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDir, "../db/migrations"), // compiled: dist/db/../db/migrations -> dist/db/migrations
      path.resolve(moduleDir, "../../src/db/migrations"), // source: src/db/../../src/db/migrations
      path.resolve(process.cwd(), "src/db/migrations"),
    ];
    const migrationsFolder = candidates.find((dir) => fs.existsSync(dir));
    if (!migrationsFolder) {
      throw new Error(`Could not locate a migrations folder (looked in: ${candidates.join(", ")})`);
    }

    console.log(`Checking and applying database migrations from ${migrationsFolder}...`);
    const { ensureMigrationBaseline } = await import("./db/baseline.js");
    await ensureMigrationBaseline(migrationsFolder);
    await migrate(db, { migrationsFolder });
    console.log("Database migrations verified and up to date!");

    await seedContent();
    console.log("Content library seed verified.");
  } catch (err: any) {
    // A failed migration leaves the schema incomplete, so the server must not
    // start and serve 500s. Failing loudly is safer than failing silently.
    console.error("Migration error on startup:", err?.message || err);
    console.error("Refusing to start: the database schema is not in a known-good state.");
    process.exit(1);
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


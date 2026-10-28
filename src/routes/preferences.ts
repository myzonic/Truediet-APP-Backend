import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { preference } from "../db/schema.js";
import { eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const preferenceRoutes = new Hono<{ Variables: Variables }>();

// Middleware: Authenticate request using Better Auth session
preferenceRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});

const NOTIFICATION_KEYS = ["push", "messages", "appointments", "webinars", "content"];
const ACCESSIBILITY_KEYS = ["largerText", "reduceMotion"];
const CONSENT_KEYS = ["personalization", "analytics"];

const DEFAULTS = {
  notifications: { push: true, messages: true, appointments: true, webinars: true, content: false },
  accessibility: { largerText: false, reduceMotion: false },
  consents: { personalization: true, analytics: false },
};

function boolMap(input: any, allowed: string[], fallback: Record<string, boolean>) {
  const out: Record<string, boolean> = { ...fallback };
  if (input && typeof input === "object") {
    for (const key of allowed) {
      if (typeof input[key] === "boolean") out[key] = input[key];
    }
  }
  return out;
}

function withDefaults(row: any) {
  return {
    notifications: { ...DEFAULTS.notifications, ...(row?.notifications || {}) },
    accessibility: { ...DEFAULTS.accessibility, ...(row?.accessibility || {}) },
    consents: { ...DEFAULTS.consents, ...(row?.consents || {}) },
  };
}

// GET /api/preferences -> current user's preferences (with defaults)
preferenceRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const row = await db.query.preference.findFirst({
    where: eq(preference.userId, user.id),
  });
  return c.json({ preferences: withDefaults(row) });
});

// PUT /api/preferences -> upsert preferences
// The client sends only the section it changed (for example just `consents`),
// so each section is merged with the stored value instead of being replaced
// by the defaults. That way toggling one setting never clears the others.
preferenceRoutes.put("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));

  const existing = await db.query.preference.findFirst({
    where: eq(preference.userId, user.id),
  });

  const current = withDefaults(existing);

  const notifications =
    body?.notifications && typeof body.notifications === "object"
      ? boolMap(body.notifications, NOTIFICATION_KEYS, current.notifications)
      : current.notifications;
  const accessibility =
    body?.accessibility && typeof body.accessibility === "object"
      ? boolMap(body.accessibility, ACCESSIBILITY_KEYS, current.accessibility)
      : current.accessibility;
  const consents =
    body?.consents && typeof body.consents === "object"
      ? boolMap(body.consents, CONSENT_KEYS, current.consents)
      : current.consents;

  if (existing) {
    await db
      .update(preference)
      .set({ notifications, accessibility, consents, updatedAt: new Date() })
      .where(eq(preference.userId, user.id));
  } else {
    // The preferences row is keyed by user id, so the insert has to tolerate
    // a concurrent request having created it first.
    await db
      .insert(preference)
      .values({
        userId: user.id,
        notifications,
        accessibility,
        consents,
      })
      .onConflictDoNothing({ target: preference.userId });
  }

  const stored = await db.query.preference.findFirst({
    where: eq(preference.userId, user.id),
  });

  return c.json({ preferences: stored ? withDefaults(stored) : { notifications, accessibility, consents } });
});

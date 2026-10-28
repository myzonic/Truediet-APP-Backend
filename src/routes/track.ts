import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { mealLog, hungerCheckin } from "../db/schema.js";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { nextDay, resolveDay, validateMeal, validateRating } from "../lib/validation.js";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const trackRoutes = new Hono<{ Variables: Variables }>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authentication is applied per route instead of with a blanket `use("*")`.
 *
 * This router is mounted at `/api`, so a wildcard middleware would also cover
 * unrelated public endpoints such as `/api/content` and `/api/plans`.
 */
async function requireSession(c: any, next: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  await next();
}

// GET /api/meals?date=YYYY-MM-DD -> the user's meals for a day (defaults to today)
trackRoutes.get("/meals", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const start = resolveDay(c.req.query("date"));
  const end = nextDay(start);

  const rows = await db
    .select()
    .from(mealLog)
    .where(and(eq(mealLog.userId, user.id), gte(mealLog.loggedAt, start), lt(mealLog.loggedAt, end)))
    .orderBy(desc(mealLog.loggedAt));

  return c.json({ date: start.toISOString().slice(0, 10), meals: rows });
});

// POST /api/meals -> log a meal
trackRoutes.post("/meals", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));

  const { value, error } = validateMeal(body?.mealType);
  if (error || !value) return c.json({ error: error || "Invalid meal" }, 400);

  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!description) return c.json({ error: "description is required" }, 400);
  if (description.length > 2000) return c.json({ error: "description is too long" }, 400);

  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 2000) : null;
  const source = body?.source === "voice" ? "voice" : "manual";

  const [created] = await db
    .insert(mealLog)
    .values({
      userId: user.id,
      mealType: value.mealType,
      description,
      notes: notes || null,
      source,
    })
    .returning();

  return c.json({ meal: created }, 201);
});

// DELETE /api/meals/:id -> remove one of the user's meals
trackRoutes.delete("/meals/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");

  if (!UUID_PATTERN.test(id)) {
    return c.json({ error: "Not found" }, 404);
  }

  const deleted = await db
    .delete(mealLog)
    .where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id)))
    .returning();

  if (!deleted.length) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: true });
});

// GET /api/hunger -> recent hunger & fullness check-ins
trackRoutes.get("/hunger", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select()
    .from(hungerCheckin)
    .where(eq(hungerCheckin.userId, user.id))
    .orderBy(desc(hungerCheckin.createdAt))
    .limit(50);
  return c.json({ checkins: rows });
});

// POST /api/hunger -> record a hunger & fullness check-in
trackRoutes.post("/hunger", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));

  const before = validateRating(body?.hungerBefore);
  if (before.error) return c.json({ error: `hungerBefore: ${before.error}` }, 400);
  const after = validateRating(body?.fullnessAfter);
  if (after.error) return c.json({ error: `fullnessAfter: ${after.error}` }, 400);

  if (before.value === null && after.value === null) {
    return c.json({ error: "Provide a hunger and/or fullness rating" }, 400);
  }

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : null;

  // A check-in may only reference one of the caller's own meal logs.
  let mealLogId: string | null = null;
  if (typeof body?.mealLogId === "string" && body.mealLogId) {
    const owned = await db
      .select({ id: mealLog.id })
      .from(mealLog)
      .where(and(eq(mealLog.id, body.mealLogId), eq(mealLog.userId, user.id)))
      .limit(1);
    if (!owned.length) {
      return c.json({ error: "not_found", message: "mealLogId does not belong to this user" }, 404);
    }
    mealLogId = owned[0].id;
  }

  const [created] = await db
    .insert(hungerCheckin)
    .values({
      userId: user.id,
      mealLogId,
      hungerBefore: before.value,
      fullnessAfter: after.value,
      note: note || null,
    })
    .returning();

  return c.json({ checkin: created }, 201);
});

// GET /api/progress -> lightweight summary across the last 7 days
trackRoutes.get("/progress", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const today = resolveDay(undefined);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekEnd = nextDay(today);

  const meals = await db
    .select()
    .from(mealLog)
    .where(and(eq(mealLog.userId, user.id), gte(mealLog.loggedAt, weekStart), lt(mealLog.loggedAt, weekEnd)));

  const checkins = await db
    .select()
    .from(hungerCheckin)
    .where(and(eq(hungerCheckin.userId, user.id), gte(hungerCheckin.createdAt, weekStart), lt(hungerCheckin.createdAt, weekEnd)));

  const days: { date: string; count: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const count =
      meals.filter((m) => m.loggedAt.toISOString().slice(0, 10) === key).length +
      checkins.filter((c2) => c2.createdAt.toISOString().slice(0, 10) === key).length;
    days.push({ date: key, count });
  }

  const todayKey = today.toISOString().slice(0, 10);
  const todayMeals = meals.filter((m) => m.loggedAt.toISOString().slice(0, 10) === todayKey);

  return c.json({
    today: {
      date: todayKey,
      meals: todayMeals.length,
      checkins: checkins.filter((c2) => c2.createdAt.toISOString().slice(0, 10) === todayKey).length,
    },
    week: {
      meals: meals.length,
      checkins: checkins.length,
      days,
    },
  });
});

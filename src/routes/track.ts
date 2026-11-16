import { Hono } from "hono";
import { db } from "../db/index.js";
import { mealLog, hungerCheckin, weightEntry, preference } from "../db/schema.js";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { nextDay, parseLimit, resolveDay, validateMeal, validateRating, validateWeight } from "../lib/validation.js";
import { getAuthUserFromRequest } from "../lib/session.js";

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
  const user = await getAuthUserFromRequest(c);

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", { id: user.id, name: user.name, email: user.email, image: user.image });
  c.set("session", { id: "", userId: user.id, token: "", expiresAt: new Date() });
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

  return c.json({ date: start.toISOString().slice(0, 10), meals: rows.filter((r) => r.mealType !== "water") });
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

// PATCH /api/meals/:id -> update an existing meal entry
trackRoutes.patch("/meals/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) {
    return c.json({ error: "Not found" }, 404);
  }

  const [existing] = await db
    .select()
    .from(mealLog)
    .where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id)))
    .limit(1);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  let nextMealType = existing.mealType;
  if (body?.mealType !== undefined) {
    const validated = validateMeal(body.mealType);
    if (validated.error || !validated.value) {
      return c.json({ error: validated.error || "Invalid meal" }, 400);
    }
    nextMealType = validated.value.mealType;
  }

  const description =
    typeof body?.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 2000)
      : existing.description;
  const notes =
    body?.notes !== undefined
      ? typeof body.notes === "string"
        ? body.notes.trim().slice(0, 2000) || null
        : null
      : existing.notes;

  const [updated] = await db
    .update(mealLog)
    .set({
      mealType: nextMealType,
      description,
      notes,
    })
    .where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id)))
    .returning();

  return c.json({ meal: updated });
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

// GET /api/weight -> weight history, newest first
trackRoutes.get("/weight", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const limit = parseLimit(c.req.query("limit"), 90, 365);
  const entries = await db
    .select()
    .from(weightEntry)
    .where(eq(weightEntry.userId, user.id))
    .orderBy(desc(weightEntry.recordedAt), desc(weightEntry.createdAt))
    .limit(limit);
  return c.json({ entries });
});

// POST /api/weight { weight, recordedAt? } -> log a weighing
trackRoutes.post("/weight", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));

  const validated = validateWeight(body?.weight);
  if (validated.error) return c.json({ error: validated.error }, 400);

  let recordedAt = new Date();
  if (typeof body?.recordedAt === "string" && body.recordedAt) {
    const parsed = new Date(body.recordedAt);
    if (!Number.isNaN(parsed.getTime())) recordedAt = parsed;
  }

  const [created] = await db
    .insert(weightEntry)
    .values({ userId: user.id, weight: validated.value as string, recordedAt })
    .returning();

  return c.json({ entry: created }, 201);
});

// DELETE /api/weight/:id -> remove one of the caller's entries
trackRoutes.delete("/weight/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");

  if (!UUID_PATTERN.test(id)) {
    return c.json({ error: "not_found", message: "Weight entry not found" }, 404);
  }

  const deleted = await db
    .delete(weightEntry)
    .where(and(eq(weightEntry.id, id), eq(weightEntry.userId, user.id)))
    .returning();

  if (!deleted.length) {
    return c.json({ error: "not_found", message: "Weight entry not found" }, 404);
  }
  return c.json({ deleted: true });
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

// ==========================================
// Water & Tracking Settings (stored safely on the existing tables)
// ==========================================

async function getWaterGoalForUser(userId: string): Promise<{ waterGoalMl: number; weightGoal: string | null }> {
  const [pref] = await db.select().from(preference).where(eq(preference.userId, userId)).limit(1);
  const raw = (pref?.consents || {}) as Record<string, unknown>;
  const waterGoalMl = typeof raw.waterGoalMl === "number" && raw.waterGoalMl >= 500 ? raw.waterGoalMl : 2000;
  const weightGoal = typeof raw.weightGoal === "string" ? raw.weightGoal : null;
  return { waterGoalMl, weightGoal };
}

// GET /api/water-summary -> today's water intake total + daily goal
trackRoutes.get("/water-summary", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const start = resolveDay(c.req.query("date"));
  const end = nextDay(start);
  const { waterGoalMl } = await getWaterGoalForUser(user.id);

  const rows = await db
    .select()
    .from(mealLog)
    .where(and(eq(mealLog.userId, user.id), eq(mealLog.mealType, "water"), gte(mealLog.loggedAt, start), lt(mealLog.loggedAt, end)))
    .orderBy(desc(mealLog.loggedAt));

  let totalMl = 0;
  const entries = rows.map((r) => {
    const ml = Math.max(0, parseInt(r.description.replace(/[^0-9]/g, ""), 10) || 0);
    totalMl += ml;
    return { id: r.id, amountMl: ml, loggedAt: r.loggedAt };
  });

  return c.json({ dailyGoalMl: waterGoalMl, totalMl, entries });
});

// POST /api/water { amountMl } -> log water intake
trackRoutes.post("/water", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const amountMl = Math.round(Number(body?.amountMl) || 0);
  if (amountMl < 10 || amountMl > 5000) {
    return c.json({ error: "Provide an amount between 10 and 5000 ml" }, 400);
  }

  const [created] = await db
    .insert(mealLog)
    .values({
      userId: user.id,
      mealType: "water",
      description: `${amountMl} ml water`,
      notes: typeof body?.notes === "string" ? body.notes.trim().slice(0, 500) : null,
      source: "manual",
    })
    .returning();

  return c.json(
    {
      entry: {
        id: created.id,
        userId: created.userId,
        weight: String(amountMl),
        amountMl,
        recordedAt: created.loggedAt,
        createdAt: created.createdAt,
      },
    },
    201
  );
});

// PATCH /api/water/:id { amountMl }
trackRoutes.patch("/water/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const amountMl = Math.round(Number(body?.amountMl) || 0);
  if (amountMl < 10 || amountMl > 5000) {
    return c.json({ error: "Provide an amount between 10 and 5000 ml" }, 400);
  }

  const [updated] = await db
    .update(mealLog)
    .set({ description: `${amountMl} ml water` })
    .where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id), eq(mealLog.mealType, "water")))
    .returning();
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ entry: updated });
});

// DELETE /api/water/:id
trackRoutes.delete("/water/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);

  const deleted = await db
    .delete(mealLog)
    .where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id), eq(mealLog.mealType, "water")))
    .returning();
  if (!deleted.length) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: true });
});

// GET /api/tracking-settings
trackRoutes.get("/tracking-settings", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const settings = await getWaterGoalForUser(user.id);
  return c.json(settings);
});

// POST /api/tracking-settings { waterGoalMl, weightGoal }
trackRoutes.post("/tracking-settings", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const waterGoalMl = Math.min(10000, Math.max(500, Math.round(Number(body?.waterGoalMl) || 2000)));
  const weightGoal = typeof body?.weightGoal === "string" ? body.weightGoal.trim().slice(0, 40) : null;

  const [existing] = await db.select().from(preference).where(eq(preference.userId, user.id)).limit(1);
  const nextConsents = {
    ...(existing?.consents || {}),
    waterGoalMl: waterGoalMl as any,
    weightGoal: weightGoal as any,
  };

  if (existing) {
    await db
      .update(preference)
      .set({ consents: nextConsents, updatedAt: new Date() })
      .where(eq(preference.userId, user.id));
  } else {
    await db.insert(preference).values({
      userId: user.id,
      notifications: {},
      accessibility: {},
      consents: nextConsents,
    });
  }

  return c.json({ waterGoalMl, weightGoal });
});

// GET /api/voice-transcriptions -> voice meal log history (metadata only, no raw audio)
trackRoutes.get("/voice-transcriptions", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select()
    .from(mealLog)
    .where(and(eq(mealLog.userId, user.id), eq(mealLog.source, "voice")))
    .orderBy(desc(mealLog.loggedAt))
    .limit(30);

  return c.json({
    transcriptions: rows.map((r) => ({
      id: r.id,
      text: r.description,
      mealType: r.mealType,
      loggedAt: r.loggedAt,
      status: "saved",
    })),
  });
});

// DELETE /api/voice-transcriptions/:id -> delete a voice meal log record
trackRoutes.delete("/voice-transcriptions/:id", requireSession, async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
  await db.delete(mealLog).where(and(eq(mealLog.id, id), eq(mealLog.userId, user.id)));
  return c.json({ deleted: true });
});

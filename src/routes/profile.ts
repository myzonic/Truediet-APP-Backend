import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { profile } from "../db/schema.js";
import { eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const profileRoutes = new Hono<{ Variables: Variables }>();

// Middleware: Authenticate request using Better Auth session
profileRoutes.use("*", async (c, next) => {
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

// GET /api/profile -> Retrieve current user's profile
profileRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string; name: string; email: string };
  const userProfile = await db.query.profile.findFirst({
    where: eq(profile.userId, user.id),
  });

  return c.json({
    user,
    profile: userProfile || null,
  });
});

// POST /api/profile -> Create or update onboarding profile
profileRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string; name: string; email: string };
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "A JSON body is required" }, 400);
  }

  const {
    displayName,
    age,
    sex,
    height,
    weight,
    goal,
    allergies,
    dietaryPreferences,
    isAssessmentComplete,
  } = body as Record<string, unknown>;

  // Only accept the documented types. `allergies` and `dietaryPreferences`
  // are stored as jsonb string arrays, so anything else is rejected rather
  // than written into the column.
  const readString = (value: unknown, max = 200): string | null =>
    typeof value === "string" ? value.trim().slice(0, max) : null;

  const readStringArray = (value: unknown): string[] | null => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) return null;
    if (!value.every((entry) => typeof entry === "string")) return null;
    return value.map((entry) => entry.trim().slice(0, 100)).filter(Boolean).slice(0, 50);
  };

  const allergiesList = readStringArray(allergies);
  const dietaryList = readStringArray(dietaryPreferences);

  if (allergies !== undefined && allergies !== null && allergiesList === null) {
    return c.json({ error: "invalid_request", message: "allergies must be an array of strings" }, 400);
  }
  if (
    dietaryPreferences !== undefined &&
    dietaryPreferences !== null &&
    dietaryList === null
  ) {
    return c.json({ error: "invalid_request", message: "dietaryPreferences must be an array of strings" }, 400);
  }

  const existingProfile = await db.query.profile.findFirst({
    where: eq(profile.userId, user.id),
  });

  if (existingProfile) {
    const [updated] = await db
      .update(profile)
      .set({
        displayName: readString(displayName) ?? existingProfile.displayName,
        age: readString(age, 40) ?? existingProfile.age,
        sex: readString(sex, 40) ?? existingProfile.sex,
        height: readString(height, 40) ?? existingProfile.height,
        weight: readString(weight, 40) ?? existingProfile.weight,
        goal: readString(goal, 120) ?? existingProfile.goal,
        allergies: allergiesList ?? existingProfile.allergies,
        dietaryPreferences: dietaryList ?? existingProfile.dietaryPreferences,
        isAssessmentComplete:
          typeof isAssessmentComplete === "boolean"
            ? isAssessmentComplete
            : existingProfile.isAssessmentComplete,
        updatedAt: new Date(),
      })
      .where(eq(profile.userId, user.id))
      .returning();

    return c.json({ profile: updated });
  }

  // The profile row is unique per user. Inserting with a conflict guard
  // makes two concurrent first-time submissions safe instead of raising a
  // unique violation.
  const [created] = await db
    .insert(profile)
    .values({
      userId: user.id,
      displayName: readString(displayName) || user.name,
      age: readString(age, 40),
      sex: readString(sex, 40),
      height: readString(height, 40),
      weight: readString(weight, 40),
      goal: readString(goal, 120),
      allergies: allergiesList || [],
      dietaryPreferences: dietaryList || [],
      isAssessmentComplete: Boolean(isAssessmentComplete),
    })
    .onConflictDoNothing({ target: profile.userId })
    .returning();

  if (created) {
    return c.json({ profile: created }, 201);
  }

  // Another request created the row first - return the stored profile.
  const stored = await db.query.profile.findFirst({
    where: eq(profile.userId, user.id),
  });
  return c.json({ profile: stored ?? null });
});

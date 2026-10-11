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
  const body = await c.req.json();

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
  } = body;

  const existingProfile = await db.query.profile.findFirst({
    where: eq(profile.userId, user.id),
  });

  if (existingProfile) {
    const [updated] = await db
      .update(profile)
      .set({
        displayName: displayName ?? existingProfile.displayName,
        age: age ?? existingProfile.age,
        sex: sex ?? existingProfile.sex,
        height: height ?? existingProfile.height,
        weight: weight ?? existingProfile.weight,
        goal: goal ?? existingProfile.goal,
        allergies: allergies ?? existingProfile.allergies,
        dietaryPreferences: dietaryPreferences ?? existingProfile.dietaryPreferences,
        isAssessmentComplete:
          isAssessmentComplete !== undefined
            ? isAssessmentComplete
            : existingProfile.isAssessmentComplete,
        updatedAt: new Date(),
      })
      .where(eq(profile.userId, user.id))
      .returning();

    return c.json({ profile: updated });
  }

  const [created] = await db
    .insert(profile)
    .values({
      userId: user.id,
      displayName: displayName || user.name,
      age,
      sex,
      height,
      weight,
      goal,
      allergies: allergies || [],
      dietaryPreferences: dietaryPreferences || [],
      isAssessmentComplete: Boolean(isAssessmentComplete),
    })
    .returning();

  return c.json({ profile: created }, 201);
});

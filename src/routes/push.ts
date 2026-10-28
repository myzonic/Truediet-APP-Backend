import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { pushToken } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const pushRoutes = new Hono<{ Variables: Variables }>();

// Middleware: Authenticate request using Better Auth session
pushRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});

function isValidExpoToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

// GET /api/push-tokens -> tokens registered to the current user
pushRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select({ token: pushToken.token, platform: pushToken.platform, createdAt: pushToken.createdAt })
    .from(pushToken)
    .where(eq(pushToken.userId, user.id));
  return c.json({ tokens: rows });
});

// POST /api/push-tokens { token, platform } -> register this device
pushRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const platform = typeof body?.platform === "string" ? body.platform.trim().toLowerCase() : "unknown";

  if (!token || !isValidExpoToken(token)) {
    return c.json({ error: "invalid_request", message: "A valid Expo push token is required" }, 400);
  }

  // A token is globally unique, so it can only ever belong to one account.
  // If it is already registered to a different user the request is rejected
  // rather than silently reassigning it.
  const existing = await db
    .select({ userId: pushToken.userId })
    .from(pushToken)
    .where(eq(pushToken.token, token))
    .limit(1);

  if (existing[0] && existing[0].userId !== user.id) {
    return c.json({ error: "conflict", message: "This device token is registered to another account" }, 409);
  }

  await db
    .insert(pushToken)
    .values({ userId: user.id, token, platform })
    .onConflictDoUpdate({ target: pushToken.token, set: { platform } });

  return c.json({ registered: true }, 201);
});

// DELETE /api/push-tokens/:token -> unregister this device
pushRoutes.delete("/:token", async (c) => {
  const user = c.get("user") as { id: string };
  const token = c.req.param("token");

  await db
    .delete(pushToken)
    .where(and(eq(pushToken.userId, user.id), eq(pushToken.token, token)));

  return c.json({ registered: false });
});

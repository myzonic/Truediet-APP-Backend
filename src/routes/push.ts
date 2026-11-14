import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { notificationLog, pushToken } from "../db/schema.js";
import { and, desc, eq, ne } from "drizzle-orm";

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

function readString(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

// GET /api/push-tokens -> devices registered to the current user
pushRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select({
      token: pushToken.token,
      platform: pushToken.platform,
      deviceId: pushToken.deviceId,
      isActive: pushToken.isActive,
      lastSuccessAt: pushToken.lastSuccessAt,
      createdAt: pushToken.createdAt,
    })
    .from(pushToken)
    .where(eq(pushToken.userId, user.id));
  return c.json({ tokens: rows });
});

// GET /api/push-tokens/history -> the notifications this member received
pushRoutes.get("/history", async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select({
      id: notificationLog.id,
      category: notificationLog.category,
      title: notificationLog.title,
      body: notificationLog.body,
      data: notificationLog.data,
      createdAt: notificationLog.createdAt,
      deliveries: notificationLog.deliveries,
    })
    .from(notificationLog)
    .where(eq(notificationLog.userId, user.id))
    .orderBy(desc(notificationLog.createdAt))
    .limit(50);
  return c.json({ notifications: rows });
});

// GET /api/push-tokens/diagnostics?userId=... -> staff-only health check.
// Reports counts and status only - never a token value - so support can see
// why a member is not receiving notifications.
pushRoutes.get("/diagnostics", async (c) => {
  if (!c.get("staff")) {
    return c.json({ error: "forbidden", message: "Staff access required" }, 403);
  }
  const userId = c.req.query("userId") || "";
  if (!userId) {
    return c.json({ error: "invalid_request", message: "userId is required" }, 400);
  }

  const rows = await db
    .select({
      platform: pushToken.platform,
      deviceId: pushToken.deviceId,
      isActive: pushToken.isActive,
      createdAt: pushToken.createdAt,
      lastSeenAt: pushToken.lastSeenAt,
      lastSuccessAt: pushToken.lastSuccessAt,
      lastError: pushToken.lastError,
    })
    .from(pushToken)
    .where(eq(pushToken.userId, userId));

  return c.json({
    userId,
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
    devices: rows,
  });
});

// POST /api/push-tokens { token, platform, deviceId } -> register this device
pushRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const token = readString(body?.token, 400);
  const platform = (readString(body?.platform, 20) || "unknown").toLowerCase();
  const deviceId = readString(body?.deviceId, 200);

  if (!token || !isValidExpoToken(token)) {
    return c.json({ error: "invalid_request", message: "A valid Expo push token is required" }, 400);
  }
  if (!["ios", "android", "web"].includes(platform)) {
    return c.json({ error: "invalid_request", message: "platform must be ios, android or web" }, 400);
  }

  // A token is globally unique, so it can only ever belong to one account.
  // If it is already registered to a different user the request is rejected
  // rather than silently reassigning it (that would leak one member's
  // notifications to another).
  const existing = await db
    .select({ userId: pushToken.userId })
    .from(pushToken)
    .where(eq(pushToken.token, token))
    .limit(1);

  if (existing[0] && existing[0].userId !== user.id) {
    return c.json({ error: "conflict", message: "This device token is registered to another account" }, 409);
  }

  // Expo can reissue a token for the same install. Retire the previous token
  // so the member does not accumulate ghost devices.
  if (deviceId) {
    await db
      .update(pushToken)
      .set({ isActive: false, lastError: "token_rotated", updatedAt: new Date() })
      .where(
        and(
          eq(pushToken.userId, user.id),
          eq(pushToken.deviceId, deviceId),
          ne(pushToken.token, token)
        )
      );
  }

  await db
    .insert(pushToken)
    .values({ userId: user.id, token, platform, deviceId, isActive: true, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: pushToken.token,
      set: {
        // Re-registering an existing token reactivates it: the member may have
        // reinstalled the app on a device Expo previously reported as dead.
        isActive: true,
        platform,
        deviceId: deviceId ?? undefined,
        lastSeenAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      },
    });

  return c.json({ registered: true }, 201);
});

// DELETE /api/push-tokens/:token -> unregister one device
pushRoutes.delete("/:token", async (c) => {
  const user = c.get("user") as { id: string };
  const token = c.req.param("token");

  await db
    .delete(pushToken)
    .where(and(eq(pushToken.userId, user.id), eq(pushToken.token, token)));

  return c.json({ registered: false });
});

// POST /api/push-tokens/sign-out { deviceId, token } -> called on logout.
// Deletes rather than deactivates so a shared phone cannot receive the
// previous member's notifications after they sign out.
pushRoutes.post("/sign-out", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const token = readString(body?.token, 400);
  const deviceId = readString(body?.deviceId, 200);

  if (token) {
    await db.delete(pushToken).where(and(eq(pushToken.userId, user.id), eq(pushToken.token, token)));
  } else if (deviceId) {
    await db
      .delete(pushToken)
      .where(and(eq(pushToken.userId, user.id), eq(pushToken.deviceId, deviceId)));
  } else {
    return c.json({ error: "invalid_request", message: "token or deviceId is required" }, 400);
  }

  return c.json({ registered: false });
});

import { Hono } from "hono";
import crypto from "node:crypto";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { message, messageThread, user as userTable } from "../db/schema.js";
import { validateMessageBody } from "../lib/validation.js";
import { sendPushToUser } from "../lib/push.js";
import { and, asc, desc, eq } from "drizzle-orm";

type Variables = {
  user?: { id: string; name: string; email: string; image?: string | null };
  staff?: boolean;
};

export const messageRoutes = new Hono<{ Variables: Variables }>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function expectedStaffKey(): string {
  return (process.env.DIETITIAN_API_KEY || "").trim();
}

function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Auth: a member session, or - for the dietitian - the DIETITIAN_API_KEY sent
// as x-dietitian-key. An explicit key attempt never silently falls back to
// session auth, so a missing or wrong key fails loudly.
messageRoutes.use("*", async (c, next) => {
  const providedKey = c.req.raw.headers.get("x-dietitian-key");
  if (providedKey !== null) {
    const expected = expectedStaffKey();
    if (!expected) {
      return c.json(
        { error: "dietitian_key_not_configured", message: "DIETITIAN_API_KEY is not set on this server." },
        503
      );
    }
    if (!keysMatch(providedKey, expected)) {
      return c.json({ error: "unauthorized", message: "Invalid dietitian key." }, 401);
    }
    c.set("staff", true);
    await next();
    return;
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  await next();
});

// GET /api/messages/threads -> user's threads, newest activity first
// Staff: every thread, with the member's name and email.
messageRoutes.get("/threads", async (c) => {
  if (c.get("staff")) {
    const threads = await db
      .select({
        id: messageThread.id,
        userId: messageThread.userId,
        status: messageThread.status,
        lastMessageAt: messageThread.lastMessageAt,
        createdAt: messageThread.createdAt,
        memberName: userTable.name,
        memberEmail: userTable.email,
      })
      .from(messageThread)
      .leftJoin(userTable, eq(userTable.id, messageThread.userId))
      .orderBy(desc(messageThread.lastMessageAt));
    return c.json({ threads });
  }

  const user = c.get("user") as { id: string };
  const threads = await db
    .select()
    .from(messageThread)
    .where(eq(messageThread.userId, user.id))
    .orderBy(desc(messageThread.lastMessageAt));
  return c.json({ threads });
});

// GET /api/messages/threads/:id -> single thread + messages (owner only;
// staff with the key may read any thread)
messageRoutes.get("/threads/:id", async (c) => {
  const id = c.req.param("id");

  if (!UUID_PATTERN.test(id)) {
    return c.json({ error: "not_found", message: "Thread not found" }, 404);
  }

  let thread;
  if (c.get("staff")) {
    [thread] = await db.select().from(messageThread).where(eq(messageThread.id, id)).limit(1);
  } else {
    const user = c.get("user") as { id: string };
    [thread] = await db
      .select()
      .from(messageThread)
      .where(and(eq(messageThread.id, id), eq(messageThread.userId, user.id)))
      .limit(1);
  }

  if (!thread) {
    return c.json({ error: "not_found", message: "Thread not found" }, 404);
  }

  const messages = await db
    .select()
    .from(message)
    .where(eq(message.threadId, thread.id))
    .orderBy(asc(message.createdAt));

  return c.json({ thread, messages });
});

// POST /api/messages { body, threadId? } -> create message (member: creates a
// thread when none is given; staff: must name an existing thread to reply to)
messageRoutes.post("/", async (c) => {
  const payload = await c.req.json().catch(() => ({}));
  const threadId = typeof payload?.threadId === "string" ? payload.threadId : undefined;
  const staff = Boolean(c.get("staff"));

  const validated = validateMessageBody(payload?.body);
  if (validated.error) {
    return c.json({ error: "invalid_request", message: validated.error }, 400);
  }
  const text = validated.value ?? "";

  const user = c.get("user") as { id: string } | undefined;

  let thread;
  if (staff) {
    // The dietitian replies into an existing conversation only.
    if (!threadId || !UUID_PATTERN.test(threadId)) {
      return c.json(
        { error: "invalid_request", message: "threadId is required to reply as the dietitian" },
        400
      );
    }
    [thread] = await db.select().from(messageThread).where(eq(messageThread.id, threadId)).limit(1);
    if (!thread) {
      return c.json({ error: "not_found", message: "Thread not found" }, 404);
    }
  } else if (threadId) {
    if (!UUID_PATTERN.test(threadId)) {
      return c.json({ error: "not_found", message: "Thread not found" }, 404);
    }
    [thread] = await db
      .select()
      .from(messageThread)
      .where(and(eq(messageThread.id, threadId), eq(messageThread.userId, user!.id)))
      .limit(1);
    if (!thread) {
      return c.json({ error: "not_found", message: "Thread not found" }, 404);
    }
  } else {
    // Reuse the user's most recent open thread, or create one.
    [thread] = await db
      .select()
      .from(messageThread)
      .where(and(eq(messageThread.userId, user!.id), eq(messageThread.status, "open")))
      .orderBy(desc(messageThread.lastMessageAt))
      .limit(1);

    if (!thread) {
      [thread] = await db
        .insert(messageThread)
        .values({ userId: user!.id })
        .returning();
    }
  }

  const [created] = await db
    .insert(message)
    .values({ threadId: thread.id, authorType: staff ? "dietitian" : "user", body: text })
    .returning();

  await db
    .update(messageThread)
    .set({ lastMessageAt: new Date() })
    .where(eq(messageThread.id, thread.id));

  // Alert the member's devices about the dietitian's reply.
  //
  // The result is awaited (rather than fired and forgotten) so the dietitian
  // can see whether the member's device was actually reached - a stored reply
  // with no notification is a common support question. A push failure never
  // fails the reply itself: the message is already stored either way.
  let push: { sent: number; failed: number; skipped?: string } | undefined;
  if (staff) {
    push = await sendPushToUser(thread.userId, {
      category: "messages",
      title: "True Diet - message from your dietitian",
      // The body is a short preview; it never repeats the member's own data.
      body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
      data: { type: "message", threadId: thread.id },
    }).catch(() => ({ sent: 0, failed: 0 }));
  }

  return c.json({ message: created, threadId: thread.id, ...(push ? { push } : {}) }, 201);
});

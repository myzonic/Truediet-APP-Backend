import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { message, messageThread } from "../db/schema.js";
import { validateMessageBody } from "../lib/validation.js";
import { and, asc, desc, eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
};

export const messageRoutes = new Hono<{ Variables: Variables }>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Middleware: Authenticate request using Better Auth session
messageRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  await next();
});

// GET /api/messages/threads -> user's threads, newest activity first
messageRoutes.get("/threads", async (c) => {
  const user = c.get("user") as { id: string };
  const threads = await db
    .select()
    .from(messageThread)
    .where(eq(messageThread.userId, user.id))
    .orderBy(desc(messageThread.lastMessageAt));
  return c.json({ threads });
});

// GET /api/messages/threads/:id -> single thread + messages (owner only)
messageRoutes.get("/threads/:id", async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");

  if (!UUID_PATTERN.test(id)) {
    return c.json({ error: "not_found", message: "Thread not found" }, 404);
  }

  const [thread] = await db
    .select()
    .from(messageThread)
    .where(and(eq(messageThread.id, id), eq(messageThread.userId, user.id)))
    .limit(1);

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

// POST /api/messages { body, threadId? } -> create message (creates thread if needed)
messageRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const payload = await c.req.json().catch(() => ({}));
  const threadId = typeof payload?.threadId === "string" ? payload.threadId : undefined;

  const validated = validateMessageBody(payload?.body);
  if (validated.error) {
    return c.json({ error: "invalid_request", message: validated.error }, 400);
  }
  const text = validated.value ?? "";

  let thread;
  if (threadId) {
    if (!UUID_PATTERN.test(threadId)) {
      return c.json({ error: "not_found", message: "Thread not found" }, 404);
    }
    [thread] = await db
      .select()
      .from(messageThread)
      .where(and(eq(messageThread.id, threadId), eq(messageThread.userId, user.id)))
      .limit(1);
    if (!thread) {
      return c.json({ error: "not_found", message: "Thread not found" }, 404);
    }
  } else {
    // Reuse the user's most recent open thread, or create one.
    [thread] = await db
      .select()
      .from(messageThread)
      .where(and(eq(messageThread.userId, user.id), eq(messageThread.status, "open")))
      .orderBy(desc(messageThread.lastMessageAt))
      .limit(1);

    if (!thread) {
      [thread] = await db
        .insert(messageThread)
        .values({ userId: user.id })
        .returning();
    }
  }

  const [created] = await db
    .insert(message)
    .values({ threadId: thread.id, authorType: "user", body: text })
    .returning();

  await db
    .update(messageThread)
    .set({ lastMessageAt: new Date() })
    .where(eq(messageThread.id, thread.id));

  return c.json({ message: created, threadId: thread.id }, 201);
});

import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { registration } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const registrationRoutes = new Hono<{ Variables: Variables }>();

registrationRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});

// GET /api/registrations -> the caller's webinar/class registrations
registrationRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select()
    .from(registration)
    .where(eq(registration.userId, user.id))
    .orderBy(desc(registration.registeredAt));

  return c.json({ registrations: rows });
});

// POST /api/registrations { title, slug, kind? } -> register the caller
registrationRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "A JSON body is required" }, 400);
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const slug = typeof body.slug === "string" ? body.slug.trim().slice(0, 200) : "";
  if (!title || !slug) {
    return c.json({ error: "invalid_request", message: "title and slug are required" }, 400);
  }

  const kind = body.kind === "class" ? "class" : "webinar";

  const [created] = await db
    .insert(registration)
    .values({ userId: user.id, title, slug, kind })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return c.json({ registration: created }, 201);
  }

  const [existing] = await db
    .select()
    .from(registration)
    .where(and(eq(registration.userId, user.id), eq(registration.slug, slug)))
    .limit(1);

  return c.json({ registration: existing ?? null });
});

// DELETE /api/registrations/:slug -> remove a registration
registrationRoutes.delete("/:slug", async (c) => {
  const user = c.get("user") as { id: string };
  const slug = c.req.param("slug");

  const deleted = await db
    .delete(registration)
    .where(and(eq(registration.userId, user.id), eq(registration.slug, slug)))
    .returning();

  if (!deleted.length) {
    return c.json({ error: "not_found", message: "Registration not found" }, 404);
  }
  return c.json({ deleted: true });
});

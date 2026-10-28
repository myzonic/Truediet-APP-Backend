import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { content, savedItem } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const savedRoutes = new Hono<{ Variables: Variables }>();

// Middleware: Authenticate request using Better Auth session
savedRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});

const routeForType: Record<string, string> = {
  article: "Article",
  myth: "MythDetail",
  resource: "ResourceDetail",
  recipe: "RecipeDetail",
  webinar: "WebinarDetail",
  class: "WebinarDetail",
  podcast: "PodcastDetail",
  topic: "Topic",
};

const ALLOWED_TYPES = new Set(Object.keys(routeForType));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the content row a save refers to.
 *
 * The mobile client saves content using its own stable ids (for example
 * `nb-1`, `myth-carbs`, `recipe-overnight-oats`) rather than the database
 * UUID, so a save has to be matched on either the UUID or the slug.
 */
async function resolveContent(contentId: string) {
  if (UUID_PATTERN.test(contentId)) {
    const byId = await db
      .select()
      .from(content)
      .where(eq(content.id, contentId))
      .limit(1);
    if (byId[0]) return byId[0];
  }

  const bySlug = await db
    .select()
    .from(content)
    .where(eq(content.slug, contentId))
    .limit(1);
  return bySlug[0] ?? null;
}

// GET /api/saved -> current user's saved content, newest first
savedRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };

  const rows = await db
    .select({ savedAt: savedItem.createdAt, item: content })
    .from(savedItem)
    .innerJoin(content, eq(savedItem.contentId, content.id))
    .where(eq(savedItem.userId, user.id))
    .orderBy(desc(savedItem.createdAt));

  return c.json({
    items: rows.map(({ savedAt, item }) => ({
      // The slug is the stable cross-device identifier the app saves with,
      // while `contentId` carries the database UUID.
      id: item.slug,
      contentId: item.id,
      slug: item.slug,
      type: item.type,
      title: item.title,
      subtitle: item.subtitle,
      category: item.category,
      isPremium: item.isPremium,
      durationMinutes: item.durationMinutes ?? undefined,
      publishedAt: item.publishedAt,
      route: routeForType[item.type] || "Article",
      savedAt,
    })),
    nextCursor: null,
  });
});

// POST /api/saved { contentId, title?, subtitle?, type? } -> idempotent save
savedRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const contentId = body?.contentId;

  if (!contentId || typeof contentId !== "string") {
    return c.json({ error: "invalid_request", message: "contentId is required" }, 400);
  }

  let existing = await resolveContent(contentId);

  // The app ships content that is not yet in the server library. When the
  // client saves such an item it sends the display metadata along, so the
  // content row is created on demand and the save can be stored against it.
  if (!existing) {
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : contentId;
    const subtitle = typeof body?.subtitle === "string" ? body.subtitle.trim() : "";
    const type = typeof body?.type === "string" && ALLOWED_TYPES.has(body.type) ? body.type : "article";

    const [created] = await db
      .insert(content)
      .values({
        slug: contentId,
        type,
        title,
        subtitle: subtitle || "Saved from the True Diet app",
      })
      .onConflictDoNothing({ target: content.slug })
      .returning();

    existing = created ?? (await resolveContent(contentId));
  }

  if (!existing) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  await db
    .insert(savedItem)
    .values({ userId: user.id, contentId: existing.id })
    .onConflictDoNothing();

  return c.json({ saved: true, contentId: existing.id, slug: existing.slug }, 201);
});

// DELETE /api/saved/:contentId -> idempotent unsave
savedRoutes.delete("/:contentId", async (c) => {
  const user = c.get("user") as { id: string };
  const contentId = c.req.param("contentId");

  const existing = await resolveContent(contentId);
  if (existing) {
    await db
      .delete(savedItem)
      .where(and(eq(savedItem.userId, user.id), eq(savedItem.contentId, existing.id)));
  }

  return c.json({ saved: false });
});

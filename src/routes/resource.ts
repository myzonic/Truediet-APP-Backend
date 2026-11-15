import { Hono } from "hono";
import { db } from "../db/index.js";
import { content, entitlement, resourceCategory, resourceProgress, subscription } from "../db/schema.js";
import { parseLimit } from "../lib/validation.js";
import { getAuthUserFromRequest } from "../lib/session.js";
import { and, desc, eq, ilike } from "drizzle-orm";

export const resourceRoutes = new Hono<{
  Variables: { user: { id: string; name: string; email: string; image?: string | null } };
}>();

// Map a content type to the mobile route that renders it.
const routeForType: Record<string, string> = {
  article: "Article",
  myth: "MythDetail",
  resource: "ResourceDetail",
  webinar: "WebinarDetail",
  class: "WebinarDetail",
  podcast: "PodcastDetail",
  topic: "Topic",
};

type ContentRow = typeof content.$inferSelect;

function summary(row: ContentRow) {
  const base = {
    id: row.id,
    slug: row.slug,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    category: row.category,
    isPremium: row.isPremium,
    durationMinutes: row.durationMinutes ?? undefined,
    publishedAt: row.publishedAt,
    route: routeForType[row.type] || "Article",
  };
  if (row.isPremium) return base;
  return {
    ...base,
    body: row.body ?? undefined,
    mediaUrl: row.mediaUrl ?? undefined,
    listenUrl: row.listenUrl ?? undefined,
    episodeNumber: row.episodeNumber ?? undefined,
    startsAt: row.startsAt ?? undefined,
  };
}

// GET /api/resource/categories -> every ResourceHub category with its icon
// and description. The client renders the browse-by-category grid from this.
resourceRoutes.get("/categories", async (c) => {
  const rows = await db
    .select()
    .from(resourceCategory)
    .orderBy(resourceCategory.sortOrder, resourceCategory.title);
  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      icon: row.icon,
    })),
  });
});

// GET /api/resource/featured -> the featured educational resources shown on
// the hub dashboard. Content is ordered by publication recency until an
// editorial `featured` flag exists in the content table.
resourceRoutes.get("/featured", async (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const rows = await db
    .select()
    .from(content)
    .where(eq(content.type, "resource"))
    .orderBy(desc(content.publishedAt))
    .limit(limit);
  return c.json({ items: rows.map(summary) });
});

// GET /api/resource/recently-added -> newest resources published.
resourceRoutes.get("/recently-added", async (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const rows = await db
    .select()
    .from(content)
    .where(eq(content.type, "resource"))
    .orderBy(desc(content.createdAt))
    .limit(limit);
  return c.json({ items: rows.map(summary) });
});

// GET /api/resource/recommended -> educational resources recommended for the
// member. The recommendation source is the freshly published library for now;
// once preferences and goals are stored per member this becomes personalized.
resourceRoutes.get("/recommended", async (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const rows = await db
    .select()
    .from(content)
    .where(and(eq(content.type, "resource"), eq(content.isPremium, false)))
    .orderBy(desc(content.publishedAt))
    .limit(limit);
  return c.json({ items: rows.map(summary) });
});

// GET /api/resource/:slug -> full resource detail, premium-gated for members.
resourceRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const [row] = await db.select().from(content).where(eq(content.slug, slug)).limit(1);

  if (!row) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  if (row.isPremium) {
    const user = await getAuthUserFromRequest(c);
    if (!user) {
      return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
    }
    const [entitled] = await db
      .select({ key: entitlement.key })
      .from(entitlement)
      .where(and(eq(entitlement.userId, user.id), eq(entitlement.key, "premium_content")))
      .limit(1);
    const [sub] = await db
      .select({ status: subscription.status })
      .from(subscription)
      .where(eq(subscription.userId, user.id))
      .limit(1);
    const hasAccess = Boolean(entitled) || sub?.status === "active" || sub?.status === "trialing";
    if (!hasAccess) {
      return c.json(
        { error: "payment_required", message: "This content requires an active True Diet membership." },
        403
      );
    }
  }

  return c.json({ item: { ...summary(row), body: row.body ?? undefined } });
});

// GET /api/resource/search?q=&type=&category=&limit= -> full-text-ish search
// across the educational resource catalog.
resourceRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  const type = c.req.query("type");
  const category = c.req.query("category");
  const limit = parseLimit(c.req.query("limit"));

  const conditions = [];
  if (type) conditions.push(eq(content.type, type));
  if (category) conditions.push(eq(content.category, category));
  if (q) conditions.push(ilike(content.title, `%${q}%`));

  const rows = await db
    .select()
    .from(content)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(content.publishedAt))
    .limit(limit);

  return c.json({
    items: rows.map((row) => ({
      ...summary(row),
      ...(row.body ? { body: row.body } : {}),
    })),
  });
});

// POST /api/resource/progress/:slug -> record that the member opened a resource
// (used by "Continue where you left off").
resourceRoutes.post("/progress/:slug", async (c) => {
  const user = await getAuthUserFromRequest(c);
  if (!user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  const slug = c.req.param("slug");
  const [row] = await db.select().from(content).where(eq(content.slug, slug)).limit(1);
  if (!row) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  const existing = await db
    .select()
    .from(resourceProgress)
    .where(
      and(
        eq(resourceProgress.userId, user.id),
        eq(resourceProgress.slug, row.slug)
      )
    )
    .limit(1);

  const progress = Math.min(100, (existing[0]?.progress ?? 0) + 10);
  const now = new Date();
  if (existing[0]) {
    await db
      .update(resourceProgress)
      .set({ progress, lastViewedAt: now, updatedAt: now })
      .where(eq(resourceProgress.userId, user.id));
  } else {
    await db.insert(resourceProgress).values({
      userId: user.id,
      contentId: row.id,
      slug: row.slug,
      title: row.title,
      type: row.type,
      progress,
      lastViewedAt: now,
    });
  }

  return c.json({ ok: true, progress });
});

export default resourceRoutes;

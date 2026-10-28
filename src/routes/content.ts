import { Hono } from "hono";
import { db } from "../db/index.js";
import { content, entitlement, subscription } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { parseLimit } from "../lib/validation.js";
import { and, desc, eq, ilike } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
};

export const contentRoutes = new Hono<{ Variables: Variables }>();

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
  return {
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
}

// GET /api/content?type=&q=&limit=  -> public list (no health data)
contentRoutes.get("/", async (c) => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const limit = parseLimit(c.req.query("limit"));

  const conditions = [];
  if (type) conditions.push(eq(content.type, type));
  if (q) conditions.push(ilike(content.title, `%${q}%`));

  const rows = await db
    .select()
    .from(content)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(content.publishedAt))
    .limit(limit);

  return c.json({ items: rows.map(summary), nextCursor: null });
});

// GET /api/content/:slug -> detail. Premium items require an active
// subscription or an explicit entitlement.
contentRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const [row] = await db.select().from(content).where(eq(content.slug, slug)).limit(1);

  if (!row) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  if (row.isPremium) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
    }

    // A premium body is only released when the account actually has access.
    const [entitled] = await db
      .select({ key: entitlement.key })
      .from(entitlement)
      .where(and(eq(entitlement.userId, session.user.id), eq(entitlement.key, "premium_content")))
      .limit(1);

    const [sub] = await db
      .select({ status: subscription.status })
      .from(subscription)
      .where(eq(subscription.userId, session.user.id))
      .limit(1);

    const hasAccess =
      Boolean(entitled) ||
      sub?.status === "active" ||
      sub?.status === "trialing";

    if (!hasAccess) {
      return c.json(
        { error: "payment_required", message: "This content requires an active True Diet membership." },
        403
      );
    }
  }

  return c.json({
    item: {
      ...summary(row),
      body: row.body,
      mediaUrl: row.mediaUrl ?? undefined,
      listenUrl: row.listenUrl ?? undefined,
      episodeNumber: row.episodeNumber ?? undefined,
      startsAt: row.startsAt ?? undefined,
      relatedIds: [],
    },
  });
});

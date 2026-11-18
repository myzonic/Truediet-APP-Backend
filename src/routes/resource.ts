import { Hono } from "hono";
import { db } from "../db/index.js";
import {
  checklist,
  checklistProgress,
  content,
  entitlement,
  groceryItem,
  groceryList,
  mealPlan,
  mealPlanEntry,
  resourceCategory,
  resourceProgress,
  resourceTemplate,
  subscription,
  worksheet,
  worksheetResponse,
} from "../db/schema.js";
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
      .where(
        and(
          eq(resourceProgress.userId, user.id),
          eq(resourceProgress.slug, row.slug)
        )
      );
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

// =====================================================================
// ResourceHub member data: meal plans, grocery lists, worksheets,
// checklists, templates and "continue where you left off" progress.
// Every route below requires the bearer JWT; rows are always scoped to
// the authenticated user id.
// =====================================================================

async function memberUser(c: any) {
  return getAuthUserFromRequest(c);
}

function parseBody(c: any) {
  return c.req.json().catch(() => ({} as Record<string, unknown>));
}

function planShape(row: typeof mealPlan.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    startDate: row.startDate ?? undefined,
    durationDays: row.durationDays,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function entryShape(row: typeof mealPlanEntry.$inferSelect) {
  return {
    id: row.id,
    dayIndex: row.dayIndex,
    mealType: row.mealType,
    title: row.title,
    description: row.description ?? undefined,
    items: Array.isArray(row.items) ? row.items : [],
    notes: row.notes ?? undefined,
  };
}

function listShape(row: typeof groceryList.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function itemShape(row: typeof groceryItem.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    notes: row.notes ?? undefined,
    purchased: row.purchased,
    sortOrder: row.sortOrder,
  };
}

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);

// ---- Meal plans ----

// GET /api/resource/meal-plans -> the member's saved plans (newest first),
// each with an entry count so the list screen can show "9 meals planned".
resourceRoutes.get("/meal-plans", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const rows = await db
    .select()
    .from(mealPlan)
    .where(eq(mealPlan.userId, user.id))
    .orderBy(desc(mealPlan.updatedAt));

  const items = [];
  for (const row of rows) {
    const entries = await db
      .select({ id: mealPlanEntry.id })
      .from(mealPlanEntry)
      .where(eq(mealPlanEntry.planId, row.id));
    items.push({ ...planShape(row), entryCount: entries.length });
  }
  return c.json({ items });
});

// POST /api/resource/meal-plans -> create a plan.
resourceRoutes.post("/meal-plans", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const body = await parseBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "validation_error", message: "Plan name is required" }, 400);

  const durationDays = Math.min(28, Math.max(1, Number(body.durationDays) || 7));
  const [row] = await db
    .insert(mealPlan)
    .values({
      userId: user.id,
      name,
      startDate: typeof body.startDate === "string" ? body.startDate : null,
      durationDays,
      notes: typeof body.notes === "string" ? body.notes : null,
    })
    .returning();
  return c.json({ item: planShape(row) }, 201);
});

// GET /api/resource/meal-plans/:id -> plan with all its entries.
resourceRoutes.get("/meal-plans/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [plan] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);

  const entries = await db
    .select()
    .from(mealPlanEntry)
    .where(eq(mealPlanEntry.planId, plan.id))
    .orderBy(mealPlanEntry.dayIndex, mealPlanEntry.mealType);

  return c.json({ item: { ...planShape(plan), entries: entries.map(entryShape) } });
});

// PATCH /api/resource/meal-plans/:id -> rename / adjust the plan.
resourceRoutes.patch("/meal-plans/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [existing] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .limit(1);
  if (!existing) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);

  const body = await parseBody(c);
  const [row] = await db
    .update(mealPlan)
    .set({
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
      startDate: typeof body.startDate === "string" ? body.startDate : existing.startDate,
      durationDays: body.durationDays ? Math.min(28, Math.max(1, Number(body.durationDays))) : existing.durationDays,
      notes: typeof body.notes === "string" ? body.notes : existing.notes,
      updatedAt: new Date(),
    })
    .where(eq(mealPlan.id, existing.id))
    .returning();
  return c.json({ item: planShape(row) });
});

// DELETE /api/resource/meal-plans/:id -> remove a plan (entries cascade).
resourceRoutes.delete("/meal-plans/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const deleted = await db
    .delete(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .returning({ id: mealPlan.id });
  if (!deleted.length) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);
  return c.json({ ok: true });
});

// PUT /api/resource/meal-plans/:id/entries -> add or update one meal slot.
// The unique index on (plan, day, meal type) makes this an idempotent upsert.
resourceRoutes.put("/meal-plans/:id/entries", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [plan] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);

  const body = await parseBody(c);
  const dayIndex = Math.max(0, Math.floor(Number(body.dayIndex)));
  const mealType = typeof body.mealType === "string" ? body.mealType : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!MEAL_TYPES.has(mealType)) {
    return c.json({ error: "validation_error", message: "mealType must be breakfast, lunch, dinner or snack" }, 400);
  }
  if (!title) return c.json({ error: "validation_error", message: "Entry title is required" }, 400);
  if (dayIndex >= plan.durationDays) {
    return c.json({ error: "validation_error", message: "Day is outside the plan length" }, 400);
  }

  const now = new Date();
  const [row] = await db
    .insert(mealPlanEntry)
    .values({
      planId: plan.id,
      dayIndex,
      mealType,
      title,
      description: typeof body.description === "string" ? body.description : null,
      items: Array.isArray(body.items) ? body.items.map(String) : [],
      notes: typeof body.notes === "string" ? body.notes : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mealPlanEntry.planId, mealPlanEntry.dayIndex, mealPlanEntry.mealType],
      set: {
        title,
        description: typeof body.description === "string" ? body.description : null,
        items: Array.isArray(body.items) ? body.items.map(String) : [],
        notes: typeof body.notes === "string" ? body.notes : null,
        updatedAt: now,
      },
    })
    .returning();
  return c.json({ item: entryShape(row) });
});

// DELETE /api/resource/meal-plans/:id/entries/:entryId
resourceRoutes.delete("/meal-plans/:id/entries/:entryId", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [plan] = await db
    .select({ id: mealPlan.id })
    .from(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);

  const deleted = await db
    .delete(mealPlanEntry)
    .where(and(eq(mealPlanEntry.id, c.req.param("entryId")), eq(mealPlanEntry.planId, plan.id)))
    .returning({ id: mealPlanEntry.id });
  if (!deleted.length) return c.json({ error: "not_found", message: "Entry not found" }, 404);
  return c.json({ ok: true });
});

// POST /api/resource/meal-plans/:id/grocery-list -> turn the plan's ingredient
// items into a fresh grocery list (deduped, case-insensitive).
resourceRoutes.post("/meal-plans/:id/grocery-list", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [plan] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.id, c.req.param("id")), eq(mealPlan.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "not_found", message: "Meal plan not found" }, 404);

  const entries = await db.select().from(mealPlanEntry).where(eq(mealPlanEntry.planId, plan.id));
  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const raw of Array.isArray(entry.items) ? entry.items : []) {
      const name = String(raw).trim();
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  if (!seen.size) return c.json({ error: "empty_plan", message: "This plan has no ingredients to add yet" }, 400);

  const [list] = await db
    .insert(groceryList)
    .values({ userId: user.id, name: `${plan.name} - grocery list`, notes: `Generated from meal plan` })
    .returning();

  let order = 0;
  for (const name of seen.values()) {
    await db.insert(groceryItem).values({ listId: list.id, name, sortOrder: order++ });
  }

  const items = await db.select().from(groceryItem).where(eq(groceryItem.listId, list.id)).orderBy(groceryItem.sortOrder);
  return c.json({ item: { ...listShape(list), items: items.map(itemShape) } }, 201);
});

// ---- Grocery lists ----

// GET /api/resource/grocery-lists -> the member's lists with item/purchased counts.
resourceRoutes.get("/grocery-lists", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const rows = await db
    .select()
    .from(groceryList)
    .where(eq(groceryList.userId, user.id))
    .orderBy(desc(groceryList.updatedAt));

  const items = [];
  for (const row of rows) {
    const groceries = await db.select().from(groceryItem).where(eq(groceryItem.listId, row.id));
    items.push({
      ...listShape(row),
      itemCount: groceries.length,
      purchasedCount: groceries.filter((g) => g.purchased).length,
    });
  }
  return c.json({ items });
});

// POST /api/resource/grocery-lists -> create a list, optionally with item names.
resourceRoutes.post("/grocery-lists", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const body = await parseBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "validation_error", message: "List name is required" }, 400);

  const [row] = await db
    .insert(groceryList)
    .values({ userId: user.id, name, notes: typeof body.notes === "string" ? body.notes : null })
    .returning();

  const names: string[] = Array.isArray(body.items) ? body.items.map(String) : [];
  let order = 0;
  for (const itemName of names) {
    const trimmed = itemName.trim();
    if (trimmed) await db.insert(groceryItem).values({ listId: row.id, name: trimmed, sortOrder: order++ });
  }

  const groceries = await db.select().from(groceryItem).where(eq(groceryItem.listId, row.id)).orderBy(groceryItem.sortOrder);
  return c.json({ item: { ...listShape(row), items: groceries.map(itemShape) } }, 201);
});

// GET /api/resource/grocery-lists/:id -> list with all items.
resourceRoutes.get("/grocery-lists/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [row] = await db
    .select()
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!row) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  const groceries = await db.select().from(groceryItem).where(eq(groceryItem.listId, row.id)).orderBy(groceryItem.sortOrder);
  return c.json({ item: { ...listShape(row), items: groceries.map(itemShape) } });
});

// PATCH /api/resource/grocery-lists/:id -> rename / note.
resourceRoutes.patch("/grocery-lists/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [existing] = await db
    .select()
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!existing) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  const body = await parseBody(c);
  const [row] = await db
    .update(groceryList)
    .set({
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
      notes: typeof body.notes === "string" ? body.notes : existing.notes,
      updatedAt: new Date(),
    })
    .where(eq(groceryList.id, existing.id))
    .returning();
  return c.json({ item: listShape(row) });
});

// DELETE /api/resource/grocery-lists/:id
resourceRoutes.delete("/grocery-lists/:id", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const deleted = await db
    .delete(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .returning({ id: groceryList.id });
  if (!deleted.length) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);
  return c.json({ ok: true });
});

// POST /api/resource/grocery-lists/:id/items -> add one item.
resourceRoutes.post("/grocery-lists/:id/items", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [row] = await db
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!row) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  const body = await parseBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "validation_error", message: "Item name is required" }, 400);

  const existingItems = await db.select({ sortOrder: groceryItem.sortOrder }).from(groceryItem).where(eq(groceryItem.listId, row.id));

  const [item] = await db
    .insert(groceryItem)
    .values({
      listId: row.id,
      name,
      category: typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Other",
      quantity: typeof body.quantity === "string" && body.quantity.trim() ? body.quantity.trim() : "1",
      unit: typeof body.unit === "string" ? body.unit.trim() : "",
      notes: typeof body.notes === "string" ? body.notes : null,
      sortOrder: existingItems.length,
    })
    .returning();

  await db.update(groceryList).set({ updatedAt: new Date() }).where(eq(groceryList.id, row.id));
  return c.json({ item: itemShape(item) }, 201);
});

// PATCH /api/resource/grocery-lists/:id/items/:itemId -> update / check off.
resourceRoutes.patch("/grocery-lists/:id/items/:itemId", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [list] = await db
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!list) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  const [existing] = await db
    .select()
    .from(groceryItem)
    .where(and(eq(groceryItem.id, c.req.param("itemId")), eq(groceryItem.listId, list.id)))
    .limit(1);
  if (!existing) return c.json({ error: "not_found", message: "Item not found" }, 404);

  const body = await parseBody(c);
  const [item] = await db
    .update(groceryItem)
    .set({
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
      category: typeof body.category === "string" && body.category.trim() ? body.category.trim() : existing.category,
      quantity: typeof body.quantity === "string" && body.quantity.trim() ? body.quantity.trim() : existing.quantity,
      unit: typeof body.unit === "string" ? body.unit.trim() : existing.unit,
      purchased: typeof body.purchased === "boolean" ? body.purchased : existing.purchased,
    })
    .where(eq(groceryItem.id, existing.id))
    .returning();

  await db.update(groceryList).set({ updatedAt: new Date() }).where(eq(groceryList.id, list.id));
  return c.json({ item: itemShape(item) });
});

// DELETE /api/resource/grocery-lists/:id/items/:itemId
resourceRoutes.delete("/grocery-lists/:id/items/:itemId", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [list] = await db
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!list) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  const deleted = await db
    .delete(groceryItem)
    .where(and(eq(groceryItem.id, c.req.param("itemId")), eq(groceryItem.listId, list.id)))
    .returning({ id: groceryItem.id });
  if (!deleted.length) return c.json({ error: "not_found", message: "Item not found" }, 404);

  await db.update(groceryList).set({ updatedAt: new Date() }).where(eq(groceryList.id, list.id));
  return c.json({ ok: true });
});

// POST /api/resource/grocery-lists/:id/clear-checked -> remove ticked items.
resourceRoutes.post("/grocery-lists/:id/clear-checked", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [list] = await db
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(and(eq(groceryList.id, c.req.param("id")), eq(groceryList.userId, user.id)))
    .limit(1);
  if (!list) return c.json({ error: "not_found", message: "Grocery list not found" }, 404);

  await db.delete(groceryItem).where(and(eq(groceryItem.listId, list.id), eq(groceryItem.purchased, true)));
  await db.update(groceryList).set({ updatedAt: new Date() }).where(eq(groceryList.id, list.id));
  return c.json({ ok: true });
});

// ---- Worksheets ----

function worksheetShape(row: typeof worksheet.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    description: row.description,
    intro: row.intro,
    instructions: row.instructions,
    fields: Array.isArray(row.fields) ? row.fields : [],
  };
}

// GET /api/resource/worksheets -> active worksheets, each with the member's
// completion state when a bearer token is present.
resourceRoutes.get("/worksheets", async (c) => {
  const rows = await db.select().from(worksheet).where(eq(worksheet.isActive, true)).orderBy(worksheet.category, worksheet.title);
  const user = await memberUser(c);

  const items = [];
  for (const row of rows) {
    let completed = false;
    let started = false;
    if (user) {
      const [response] = await db
        .select()
        .from(worksheetResponse)
        .where(and(eq(worksheetResponse.userId, user.id), eq(worksheetResponse.worksheetId, row.id)))
        .limit(1);
      completed = Boolean(response?.completed);
      started = Boolean(response) && !completed;
    }
    items.push({ ...worksheetShape(row), completed, started });
  }
  return c.json({ items });
});

// GET /api/resource/worksheets/:slug -> worksheet with the member's saved answers.
resourceRoutes.get("/worksheets/:slug", async (c) => {
  const [row] = await db.select().from(worksheet).where(eq(worksheet.slug, c.req.param("slug"))).limit(1);
  if (!row) return c.json({ error: "not_found", message: "Worksheet not found" }, 404);

  let answers: Record<string, unknown> = {};
  let completed = false;
  const user = await memberUser(c);
  if (user) {
    const [response] = await db
      .select()
      .from(worksheetResponse)
      .where(and(eq(worksheetResponse.userId, user.id), eq(worksheetResponse.worksheetId, row.id)))
      .limit(1);
    if (response) {
      answers = (response.answers && typeof response.answers === "object" ? response.answers : {}) as Record<string, unknown>;
      completed = response.completed;
    }
  }
  return c.json({ item: { ...worksheetShape(row), answers, completed } });
});

// PUT /api/resource/worksheets/:slug/answers -> save (draft or completed).
resourceRoutes.put("/worksheets/:slug/answers", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [row] = await db.select().from(worksheet).where(eq(worksheet.slug, c.req.param("slug"))).limit(1);
  if (!row) return c.json({ error: "not_found", message: "Worksheet not found" }, 404);

  const body = await parseBody(c);
  const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : {};
  const completed = Boolean(body.completed);
  const now = new Date();

  const [saved] = await db
    .insert(worksheetResponse)
    .values({ userId: user.id, worksheetId: row.id, answers, completed, completedAt: completed ? now : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [worksheetResponse.userId, worksheetResponse.worksheetId],
      set: {
        answers,
        completed,
        completedAt: completed ? now : null,
        updatedAt: now,
      },
    })
    .returning();

  return c.json({ item: { answers: saved.answers, completed: saved.completed } });
});

// ---- Checklists ----

function checklistShape(row: typeof checklist.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    description: row.description,
    items: Array.isArray(row.items) ? row.items : [],
  };
}

// GET /api/resource/checklists -> active checklists with per-user progress.
resourceRoutes.get("/checklists", async (c) => {
  const rows = await db.select().from(checklist).where(eq(checklist.isActive, true)).orderBy(checklist.category, checklist.title);
  const user = await memberUser(c);

  const items = [];
  for (const row of rows) {
    let checked: Record<string, boolean> = {};
    if (user) {
      const [progress] = await db
        .select()
        .from(checklistProgress)
        .where(and(eq(checklistProgress.userId, user.id), eq(checklistProgress.checklistId, row.id)))
        .limit(1);
      checked = (progress?.checked && typeof progress.checked === "object" ? progress.checked : {}) as Record<string, boolean>;
    }
    const total = (Array.isArray(row.items) ? row.items : []).length;
    items.push({
      ...checklistShape(row),
      checkedCount: Object.values(checked).filter(Boolean).length,
      total,
    });
  }
  return c.json({ items });
});

// GET /api/resource/checklists/:slug -> items + the member's checked map.
resourceRoutes.get("/checklists/:slug", async (c) => {
  const [row] = await db.select().from(checklist).where(eq(checklist.slug, c.req.param("slug"))).limit(1);
  if (!row) return c.json({ error: "not_found", message: "Checklist not found" }, 404);

  let checked: Record<string, boolean> = {};
  const user = await memberUser(c);
  if (user) {
    const [progress] = await db
      .select()
      .from(checklistProgress)
      .where(and(eq(checklistProgress.userId, user.id), eq(checklistProgress.checklistId, row.id)))
      .limit(1);
    if (progress) checked = (progress.checked && typeof progress.checked === "object" ? progress.checked : {}) as Record<string, boolean>;
  }
  return c.json({ item: { ...checklistShape(row), checked } });
});

// POST /api/resource/checklists/:slug/toggle -> set one item's state.
resourceRoutes.post("/checklists/:slug/toggle", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const [row] = await db.select().from(checklist).where(eq(checklist.slug, c.req.param("slug"))).limit(1);
  if (!row) return c.json({ error: "not_found", message: "Checklist not found" }, 404);

  const body = await parseBody(c);
  const key = typeof body.key === "string" ? body.key : "";
  const value = Boolean(body.checked);
  if (!key) return c.json({ error: "validation_error", message: "key is required" }, 400);

  const [existing] = await db
    .select()
    .from(checklistProgress)
    .where(and(eq(checklistProgress.userId, user.id), eq(checklistProgress.checklistId, row.id)))
    .limit(1);
  const checked = { ...((existing?.checked && typeof existing.checked === "object" ? existing.checked : {}) as Record<string, boolean>), [key]: value };
  const now = new Date();

  await db
    .insert(checklistProgress)
    .values({ userId: user.id, checklistId: row.id, checked, updatedAt: now })
    .onConflictDoUpdate({
      target: [checklistProgress.userId, checklistProgress.checklistId],
      set: { checked, updatedAt: now },
    });

  return c.json({ ok: true, checked });
});

// ---- Templates ----

function templateShape(row: typeof resourceTemplate.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    description: row.description,
    fields: Array.isArray(row.fields) ? row.fields : [],
  };
}

// GET /api/resource/templates -> the printable/usable template library.
resourceRoutes.get("/templates", async (c) => {
  const rows = await db
    .select()
    .from(resourceTemplate)
    .where(eq(resourceTemplate.isActive, true))
    .orderBy(resourceTemplate.category, resourceTemplate.title);
  return c.json({ items: rows.map(templateShape) });
});

// GET /api/resource/templates/:slug -> one template with its fields.
resourceRoutes.get("/templates/:slug", async (c) => {
  const [row] = await db.select().from(resourceTemplate).where(eq(resourceTemplate.slug, c.req.param("slug"))).limit(1);
  if (!row) return c.json({ error: "not_found", message: "Template not found" }, 404);
  return c.json({ item: templateShape(row) });
});

// ---- Progress / "continue where you left off" ----

// GET /api/resource/progress -> recently viewed resources (unfinished first)
// plus completed ones, for the hub dashboard and My Resources screen.
resourceRoutes.get("/progress", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const limit = parseLimit(c.req.query("limit"));
  const rows = await db
    .select()
    .from(resourceProgress)
    .where(eq(resourceProgress.userId, user.id))
    .orderBy(desc(resourceProgress.lastViewedAt))
    .limit(Math.min(50, limit * 4));

  const shape = (row: typeof resourceProgress.$inferSelect) => ({
    slug: row.slug,
    title: row.title,
    type: row.type,
    progress: row.progress,
    completed: Boolean(row.completedAt) || row.progress >= 100,
    lastViewedAt: row.lastViewedAt,
  });

  return c.json({
    items: rows.map(shape),
    continue: rows.filter((r) => r.progress < 100 && !r.completedAt).slice(0, limit).map(shape),
    completed: rows.filter((r) => r.progress >= 100 || r.completedAt).slice(0, limit).map(shape),
  });
});

// PUT /api/resource/progress/:slug -> set exact progress (client sends 100 on
// finish so "completed" is reliable, not a guess from open counts).
resourceRoutes.put("/progress/:slug", async (c) => {
  const user = await memberUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "Authentication required" }, 401);

  const slug = c.req.param("slug");
  const body = await parseBody(c);
  const progress = Math.min(100, Math.max(0, Math.floor(Number(body.progress) || 0)));

  const [existing] = await db
    .select()
    .from(resourceProgress)
    .where(and(eq(resourceProgress.userId, user.id), eq(resourceProgress.slug, slug)))
    .limit(1);
  if (!existing) return c.json({ error: "not_found", message: "No progress recorded for this resource" }, 404);

  const now = new Date();
  const [row] = await db
    .update(resourceProgress)
    .set({ progress, completedAt: progress >= 100 ? existing.completedAt ?? now : null, updatedAt: now })
    .where(and(eq(resourceProgress.userId, user.id), eq(resourceProgress.slug, slug)))
    .returning();

  return c.json({
    item: {
      slug: row.slug,
      title: row.title,
      type: row.type,
      progress: row.progress,
      completed: Boolean(row.completedAt) || row.progress >= 100,
      lastViewedAt: row.lastViewedAt,
    },
  });
});

// GET /api/resource/:slug -> full resource detail, premium-gated for members.
//
// IMPORTANT: this catch-all MUST stay the last route on this router. Hono
// matches in registration order, so registering "/:slug" earlier makes it
// swallow every one-segment literal path below it ("/meal-plans",
// "/grocery-lists", "/worksheets", "/checklists", "/templates", "/progress",
// "/search") and answer them with "Content not found".
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

export default resourceRoutes;

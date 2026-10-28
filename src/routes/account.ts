import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import {
  user,
  profile,
  savedItem,
  content,
  messageThread,
  message,
  subscription,
  entitlement,
  preference,
  mealLog,
  hungerCheckin,
  appointment,
  registration,
} from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const accountRoutes = new Hono<{ Variables: Variables }>();

// Middleware: Authenticate request using Better Auth session
accountRoutes.use("*", async (c, next) => {
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

// GET /api/account/export -> full machine-readable copy of the user's data
accountRoutes.get("/export", async (c) => {
  const authUser = c.get("user") as { id: string };
  const userId = authUser.id;

  const [accountRow] = await db.select().from(user).where(eq(user.id, userId));
  const [profileRow] = await db.select().from(profile).where(eq(profile.userId, userId));
  const [subscriptionRow] = await db
    .select()
    .from(subscription)
    .where(eq(subscription.userId, userId));
  const [preferenceRow] = await db
    .select()
    .from(preference)
    .where(eq(preference.userId, userId));

  const savedRows = await db
    .select({
      savedAt: savedItem.createdAt,
      title: content.title,
      slug: content.slug,
      type: content.type,
    })
    .from(savedItem)
    .innerJoin(content, eq(savedItem.contentId, content.id))
    .where(eq(savedItem.userId, userId));

  const entitlementRows = await db
    .select()
    .from(entitlement)
    .where(eq(entitlement.userId, userId));

  const threadRows = await db
    .select()
    .from(messageThread)
    .where(eq(messageThread.userId, userId));
  const threadIds = threadRows.map((t) => t.id);
  const messageRows = threadIds.length
    ? await db.select().from(message).where(inArray(message.threadId, threadIds))
    : [];

  const mealRows = await db
    .select()
    .from(mealLog)
    .where(eq(mealLog.userId, userId));

  const checkinRows = await db
    .select()
    .from(hungerCheckin)
    .where(eq(hungerCheckin.userId, userId));

  const appointmentRows = await db
    .select()
    .from(appointment)
    .where(eq(appointment.userId, userId));

  const registrationRows = await db
    .select()
    .from(registration)
    .where(eq(registration.userId, userId));

  return c.json({
    exportedAt: new Date().toISOString(),
    account: accountRow
      ? {
          id: accountRow.id,
          name: accountRow.name,
          email: accountRow.email,
          emailVerified: accountRow.emailVerified,
          createdAt: accountRow.createdAt,
        }
      : null,
    profile: profileRow || null,
    savedContent: savedRows,
    messages: messageRows.map((m) => ({
      threadId: m.threadId,
      authorType: m.authorType,
      body: m.body,
      createdAt: m.createdAt,
    })),
    mealLogs: mealRows.map((m) => ({
      id: m.id,
      mealType: m.mealType,
      description: m.description,
      notes: m.notes,
      source: m.source,
      loggedAt: m.loggedAt,
      createdAt: m.createdAt,
    })),
    hungerCheckins: checkinRows.map((c2) => ({
      id: c2.id,
      mealLogId: c2.mealLogId,
      hungerBefore: c2.hungerBefore,
      fullnessAfter: c2.fullnessAfter,
      note: c2.note,
      createdAt: c2.createdAt,
    })),
    appointments: appointmentRows.map((a) => ({
      id: a.id,
      slot: a.slot,
      visitType: a.visitType,
      bookingId: a.bookingId,
      meetingUrl: a.meetingUrl,
      status: a.status,
      isoStart: a.isoStart,
      createdAt: a.createdAt,
    })),
    registrations: registrationRows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      kind: r.kind,
      registeredAt: r.registeredAt,
    })),
    subscription: subscriptionRow || null,
    entitlements: entitlementRows.map((e) => e.key),
    preferences: preferenceRow || null,
  });
});

// DELETE /api/account -> permanently delete account and all owned data (cascade)
accountRoutes.delete("/", async (c) => {
  const authUser = c.get("user") as { id: string };

  // Every app table references user.id with ON DELETE cascade,
  // so removing the user row removes the profile, saved items,
  // threads/messages, subscription, entitlements and preferences.
  await db.delete(user).where(eq(user.id, authUser.id));

  return c.json({ deleted: true });
});

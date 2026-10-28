import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { appointment } from "../db/schema.js";
import { and, desc, eq, ne } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
};

export const appointmentRoutes = new Hono<{ Variables: Variables }>();

// Every appointment is owned by exactly one account.
appointmentRoutes.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});

// GET /api/appointments -> the caller's appointments, newest first
appointmentRoutes.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const rows = await db
    .select()
    .from(appointment)
    .where(eq(appointment.userId, user.id))
    .orderBy(desc(appointment.createdAt));

  return c.json({ appointments: rows });
});

// GET /api/appointments/current -> the most recent active appointment
appointmentRoutes.get("/current", async (c) => {
  const user = c.get("user") as { id: string };
  // The most recent appointment the member has not cancelled. A booking made
  // without a calendar provider is stored as "requested" rather than
  // "confirmed", so filtering on "confirmed" would hide the appointment the
  // app just created as soon as it is reloaded or signed in elsewhere.
  const [row] = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.userId, user.id), ne(appointment.status, "cancelled")))
    .orderBy(desc(appointment.createdAt))
    .limit(1);

  return c.json({ appointment: row ?? null });
});

// POST /api/appointments -> record a booked appointment
appointmentRoutes.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "A JSON body is required" }, 400);
  }

  const slot = typeof body.slot === "string" ? body.slot.trim().slice(0, 200) : "";
  if (!slot) {
    return c.json({ error: "invalid_request", message: "slot is required" }, 400);
  }

  const visitType = body.visitType === "phone" ? "phone" : "video";
  const bookingId =
    typeof body.bookingId === "string" || typeof body.bookingId === "number"
      ? String(body.bookingId).slice(0, 200)
      : null;
  const meetingUrl = typeof body.meetingUrl === "string" ? body.meetingUrl.trim().slice(0, 2000) : null;
  const callId = typeof body.callId === "string" ? body.callId.trim().slice(0, 200) : null;

  let isoStart: Date | null = null;
  if (typeof body.isoStart === "string" && body.isoStart) {
    const parsed = new Date(body.isoStart);
    if (!Number.isNaN(parsed.getTime())) isoStart = parsed;
  }

  // A confirmed booking comes from Cal.com; anything else is a request.
  const status = bookingId ? "confirmed" : "requested";

  const [created] = await db
    .insert(appointment)
    .values({
      userId: user.id,
      slot,
      visitType,
      bookingId,
      meetingUrl,
      callId,
      isoStart,
      status,
    })
    .returning();

  return c.json({ appointment: created }, 201);
});

// PATCH /api/appointments/:id -> update the status of the caller's appointment
appointmentRoutes.patch("/:id", async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const allowed = ["requested", "confirmed", "cancelled", "completed"];
  const status = typeof body?.status === "string" && allowed.includes(body.status) ? body.status : null;

  if (!status) {
    return c.json({ error: "invalid_request", message: "A valid status is required" }, 400);
  }

  const [updated] = await db
    .update(appointment)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(appointment.id, id), eq(appointment.userId, user.id)))
    .returning();

  if (!updated) {
    return c.json({ error: "not_found", message: "Appointment not found" }, 404);
  }
  return c.json({ appointment: updated });
});

// DELETE /api/appointments/:id -> cancel the caller's appointment
appointmentRoutes.delete("/:id", async (c) => {
  const user = c.get("user") as { id: string };
  const id = c.req.param("id");

  const deleted = await db
    .delete(appointment)
    .where(and(eq(appointment.id, id), eq(appointment.userId, user.id)))
    .returning();

  if (!deleted.length) {
    return c.json({ error: "not_found", message: "Appointment not found" }, 404);
  }
  return c.json({ deleted: true });
});

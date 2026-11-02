
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointment, user } from "../db/schema.js";

// The signature-verified handler. It is registered on two URL shapes (see the
// mounts in index.ts) so the subscriber URL entered in the Cal.com dashboard
// works whether it was entered as /api/webhooks/calcom or /api/cal/webhook.
async function handleCalWebhook(c: any) {
  const secret = process.env.CAL_WEBHOOK_SECRET;

  if (!secret) {
    return c.json({ error: "webhook_not_configured" }, 503);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("x-cal-signature-256");

  if (!signature) {
    return c.json({ error: "missing_signature" }, 401);
  }

  const supplied = signature.replace(/^sha256=/i, "").trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let event: any;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const trigger = String(event?.triggerEvent || "").toUpperCase();
  const payload = event?.payload;

  if (!payload || typeof payload !== "object") {
    return c.json({ received: true, ignored: "missing_payload" });
  }

  const bookingIdValue = payload.bookingId ?? payload.id;
  const bookingId =
    typeof bookingIdValue === "string" || typeof bookingIdValue === "number"
      ? String(bookingIdValue)
      : null;

  if (!bookingId) {
    return c.json({ received: true, ignored: "missing_booking_id" });
  }

  try {
    // Cancellation: update the existing appointment only.
    if (trigger === "BOOKING_CANCELLED") {
      await db
        .update(appointment)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(appointment.bookingId, bookingId));

      console.log(`[Cal.com webhook] Booking cancelled: ${bookingId}`);

      return c.json({ received: true, bookingId, status: "cancelled" });
    }

    // Only create or synchronize confirmed bookings.
    if (
      trigger !== "BOOKING_CREATED" &&
      trigger !== "BOOKING_RESCHEDULED"
    ) {
      return c.json({ received: true, ignored: trigger || "unknown_event" });
    }

    const attendees = Array.isArray(payload.attendees)
      ? payload.attendees
      : [];

    const attendeeEmail =
      attendees.find((item: any) => typeof item?.email === "string")?.email ||
      payload.attendee?.email;

    if (typeof attendeeEmail !== "string" || !attendeeEmail.trim()) {
      return c.json({ received: true, ignored: "missing_attendee_email" });
    }

    const email = attendeeEmail.trim().toLowerCase();

    const [account] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);

    if (!account) {
      console.warn(`[Cal.com webhook] No TrueDiet account for attendee email`);
      return c.json({ received: true, ignored: "account_not_found" });
    }

    const startValue = payload.startTime || payload.start;
    const startDate = startValue ? new Date(startValue) : null;

    if (!startDate || Number.isNaN(startDate.getTime())) {
      return c.json({ received: true, ignored: "invalid_start_time" });
    }

    const meetingUrl =
      payload.metadata?.videoCallUrl ||
      payload.videoCallData?.url ||
      payload.location ||
      null;

    const safeMeetingUrl =
      typeof meetingUrl === "string" ? meetingUrl.slice(0, 2000) : null;

    const [existing] = await db
      .select({ id: appointment.id })
      .from(appointment)
      .where(eq(appointment.bookingId, bookingId))
      .limit(1);

    if (existing) {
      await db
        .update(appointment)
        .set({
          userId: account.id,
          slot: startDate.toISOString(),
          isoStart: startDate,
          bookingId,
          meetingUrl: safeMeetingUrl,
          status: "confirmed",
          updatedAt: new Date(),
        })
        .where(eq(appointment.id, existing.id));
    } else {
      await db.insert(appointment).values({
        userId: account.id,
        slot: startDate.toISOString(),
        isoStart: startDate,
        bookingId,
        meetingUrl: safeMeetingUrl,
        visitType: "video",
        status: "confirmed",
      });
    }

    console.log(`[Cal.com webhook] Booking synchronized: ${bookingId}`);

    return c.json({
      received: true,
      bookingId,
      status: "confirmed",
    });
  } catch (error) {
    console.error("[Cal.com webhook] Processing failed:", error);
    return c.json({ error: "webhook_processing_failed" }, 500);
  }
}

export const calWebhookRoutes = new Hono();
calWebhookRoutes.post("/calcom", handleCalWebhook);

// The same handler is mounted under /api/cal as well, so a subscriber URL of
// /api/cal/webhook (rather than /api/webhooks/calcom) also works.
export const calWebhookAltRoutes = new Hono();
calWebhookAltRoutes.post("/webhook", handleCalWebhook);

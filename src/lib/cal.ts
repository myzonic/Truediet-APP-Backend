import crypto from "node:crypto";

// Cal.com configuration.
//
// Every value is read lazily inside the functions. Reading `process.env` at
// module-evaluation time would depend on the import order of
// `dotenv.config()`, which is fragile.
//
// Variable names (see .env.example):
//   CAL_API_KEY          required, server-side only
//   CAL_API_BASE_URL     preferred base, e.g. https://api.cal.com/v2
//   CAL_API_URL          legacy name, still honoured if the new one is absent
//   CAL_EVENT_TYPE_ID    the consultation event type (id)
//   CAL_EVENT_TYPE_ID_PHONE optional separate event type for phone visits
//   CAL_USERNAME         optional, shown in config output
//   CAL_BOOKING_URL      optional public booking page opened from the app
//   CAL_WEBHOOK_SECRET   optional, used to verify X-Cal-Signature-256

function getApiKey(): string | undefined {
  return process.env.CAL_API_KEY;
}

function getEventTypeId(): string | undefined {
  return process.env.CAL_EVENT_TYPE_ID;
}

/**
 * The API base.
 *
 * Dokploy is configured with CAL_API_BASE_URL; older checkouts used
 * CAL_API_URL. Both are accepted, CAL_API_BASE_URL wins, and the documented
 * default applies when neither is present so a missing variable can never
 * silently point at an empty string.
 */
function getCalApiBase(): string {
  const configured =
    (process.env.CAL_API_BASE_URL || "").trim() || (process.env.CAL_API_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://api.cal.com/v2";
}

/** The public booking page the app can open, if one is configured. */
function getBookingUrl(): string | undefined {
  const raw = (process.env.CAL_BOOKING_URL || "").trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** HMAC-SHA256 hex signature Cal.com sends in X-Cal-Signature-256. */
export function verifyCalSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(String(signature).trim().toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isCalConfigured(): boolean {
  return Boolean(getApiKey());
}

export function getCalConfigData() {
  const eventTypeId = getEventTypeId();
  // Phone visits use their own event type when one is configured, and fall
  // back to the shared one otherwise, so a single-variable setup still works.
  const phoneEventTypeId =
    (process.env.CAL_EVENT_TYPE_ID_PHONE || "").trim() || (eventTypeId ? String(eventTypeId) : "");

  const videoEvent = eventTypeId ? Number(eventTypeId) : undefined;
  const phoneEvent = phoneEventTypeId ? Number(phoneEventTypeId) : undefined;

  return {
    configured: isCalConfigured(),
    eventTypeId: videoEvent,
    username: process.env.CAL_USERNAME || undefined,
    apiBaseUrl: getCalApiBase(),
    bookingUrl: getBookingUrl(),
    // Both consultation formats the app offers, each with the event type it
    // books against.
    consultations: {
      video: {
        type: "video",
        label: "Video consultation",
        eventTypeId: Number.isFinite(videoEvent) ? videoEvent : undefined,
      },
      phone: {
        type: "phone",
        label: "Phone consultation",
        eventTypeId: Number.isFinite(phoneEvent) ? phoneEvent : undefined,
      },
    },
  };
}

export async function fetchCalSlots(startTime: string, endTime: string, overrideEventTypeId?: string | number) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Cal.com is not configured on the server. Please set CAL_API_KEY.");
  }

  const targetEventTypeId = overrideEventTypeId || getEventTypeId();
  if (!targetEventTypeId) {
    throw new Error("CAL_EVENT_TYPE_ID is required to fetch available slots.");
  }

  // Cal.com v2 expects /v2/slots/available?startTime=...&endTime=...&eventTypeId=...
  const params = new URLSearchParams({
    startTime,
    endTime,
    eventTypeId: String(targetEventTypeId),
  });

  const url = `${getCalApiBase()}/slots/available?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cal.com API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  // Cal.com v2 wraps slots inside data.data.slots
  const slots = data?.data?.slots || data?.slots || {};
  return { slots };
}

export async function makeCalBooking(data: {
  eventTypeId: string | number;
  start: string;
  name: string;
  email: string;
  notes?: string;
  timeZone?: string;
}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Cal.com is not configured on the server. Please set CAL_API_KEY.");
  }

  const url = `${getCalApiBase()}/bookings`;

  const payload = {
    start: data.start,
    eventTypeId: Number(data.eventTypeId) || Number(getEventTypeId()),
    attendee: {
      name: data.name,
      email: data.email,
      timeZone: data.timeZone || "UTC",
      language: "en",
    },
    // Cal.com's current API rejects a top-level `notes` property and requires
    // a booking field with the slug `title`; the caller's notes answer it.
    // Unknown slugs are ignored, so event types without that field still work.
    bookingFieldsResponses: {
      title: data.notes || "True Diet consultation",
    },
    metadata: {
      source: "truediet_mobile_app",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Without this header Cal.com serves the legacy booking schema, which
      // rejects the payload above with timeZone/language validation errors.
      "cal-api-version": "2024-08-13",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create Cal.com booking (${response.status}): ${errText}`);
  }

  const json = await response.json();
  const bookingData = json?.data || json;

  // Never fabricate a successful booking. If Cal.com did not confirm an id
  // and a status, the booking cannot be reported as accepted.
  const id = bookingData?.id;
  const status = bookingData?.status;
  if (!id || !status) {
    throw new Error("Cal.com did not return a booking confirmation.");
  }

  return {
    id,
    uid: bookingData?.uid,
    startTime: bookingData?.start || data.start,
    endTime: bookingData?.end,
    meetingUrl: bookingData?.meetingUrl || bookingData?.location || (bookingData?.references?.[0]?.meetingUrl),
    status,
  };
}

import { db } from "../db/index.js";
import { appointment, notificationLog, preference, pushToken } from "../db/schema.js";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";

/**
 * Push delivery through Expo's push service.
 *
 * Responsibilities, in order:
 *   1. respect the member's notification preferences
 *   2. pick only active device tokens
 *   3. deduplicate repeated events
 *   4. send in Expo's maximum batch size, retrying only temporary failures
 *   5. read tickets, then receipts, and deactivate dead tokens
 *
 * Nothing here logs a token, an email or a message body.
 */

export type PushCategory =
  | "messages"
  | "appointments"
  | "webinars"
  | "content"
  | "tracking"
  | "media"
  | "security";

/** Preference key that gates each category. */
const CATEGORY_SETTING: Record<PushCategory, string> = {
  messages: "messages",
  appointments: "appointments",
  webinars: "webinars",
  content: "content",
  tracking: "tracking",
  media: "media",
  security: "security",
};

/**
 * Security notices cannot be switched off: a member who disabled every other
 * category still needs to hear about a password change on their account.
 */
const ALWAYS_ON: PushCategory[] = ["security"];

const DEFAULTS: Record<string, boolean> = {
  push: true,
  messages: true,
  appointments: true,
  webinars: true,
  content: false,
  tracking: false,
  media: false,
  security: true,
};

/** Android channel per category; must match the channels the app creates. */
const CATEGORY_CHANNEL: Record<PushCategory, string> = {
  messages: "messages",
  appointments: "appointments",
  webinars: "content",
  content: "content",
  tracking: "tracking",
  media: "content",
  security: "security",
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPT_URL = "https://exp.host/--/api/v2/push/getReceipts";
const BATCH_SIZE = 100;
const MAX_RETRIES = 3;

/**
 * Name of the Android small icon drawable shipped in the app
 * (android/app/src/main/res/drawable*/ic_truediet_notification.png).
 */
const ANDROID_NOTIFICATION_ICON = "ic_truediet_notification";

export interface PushInput {
  category: PushCategory;
  title: string;
  body: string;
  /** Navigation payload; must never contain health details. */
  data?: Record<string, unknown>;
  /** Same key for the same event means "deliver once". */
  dedupeKey?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  skipped?: "no_tokens" | "preference" | "duplicate";
  /** Expo error codes, e.g. InvalidCredentials, DeviceNotRegistered. */
  errors?: string[];
  /** HTTP status when Expo rejected the whole batch. */
  httpStatus?: number;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound: "default";
  channelId: string;
  priority: "high";
  ttl?: number;
  /**
   * Android small icon. It must match a drawable resource in the app
   * (res/drawable-<density>/ic_truediet_notification.png), which is a
   * white-on-transparent silhouette of the True Diet fork mark - Android
   * renders status-bar icons as flat shapes, so the colourful launcher icon
   * cannot be used here.
   */
  icon?: string;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  return headers;
}

/**
 * True when the member allows this category. Missing rows or missing keys fall
 * back to the documented default, so a member who never opened Settings still
 * receives the notifications that are on by default.
 */
export async function allowsCategory(userId: string, category: PushCategory): Promise<boolean> {
  if (ALWAYS_ON.includes(category)) return true;

  const row = await db.query.preference.findFirst({
    where: eq(preference.userId, userId),
  });
  const settings: Record<string, boolean> = { ...DEFAULTS, ...(row?.notifications || {}) };

  // The master switch wins over every category.
  if (settings.push === false) return false;
  return settings[CATEGORY_SETTING[category]] !== false;
}

async function deactivateTokens(tokens: string[], reason: string): Promise<void> {
  if (!tokens.length) return;
  await db
    .update(pushToken)
    .set({ isActive: false, lastError: reason, updatedAt: new Date() })
    .where(inArray(pushToken.token, tokens));
}

async function postExpo(
  url: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; json: any }> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      lastStatus = response.status;
      const json = await response.json().catch(() => null);
      // Expo returns 429 with a Retry-After header, and 5xx for transient
      // trouble. Anything else is final.
      if (response.ok) return { ok: true, status: response.status, json };
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, status: response.status, json };
      }
    } catch {
      lastStatus = 0;
    }
    if (attempt < MAX_RETRIES) {
      // 0.5s, 1s, 2s - short enough to finish inside a request, long enough to
      // ride out a blip.
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  return { ok: false, status: lastStatus, json: null };
}

/**
 * Sends one notification to every active device of a member.
 *
 * Never throws: a push failure must not fail the action that triggered it.
 */
export async function sendPushToUser(userId: string, input: PushInput): Promise<PushResult> {
  try {
    if (!(await allowsCategory(userId, input.category))) {
      return { sent: 0, failed: 0, skipped: "preference" };
    }

    const rows = await db
      .select({ token: pushToken.token })
      .from(pushToken)
      .where(and(eq(pushToken.userId, userId), eq(pushToken.isActive, true)))
      .limit(25);

    if (!rows.length) return { sent: 0, failed: 0, skipped: "no_tokens" };

    // Dedupe: the unique index on (user_id, dedupe_key) makes a repeated event
    // fail here instead of reaching the phone twice.
    let logId: string | undefined;
    try {
      const [row] = await db
        .insert(notificationLog)
        .values({
          userId,
          category: input.category,
          title: input.title,
          body: input.body,
          data: input.data,
          dedupeKey: input.dedupeKey,
        })
        .returning({ id: notificationLog.id });
      logId = row?.id;
    } catch {
      return { sent: 0, failed: 0, skipped: "duplicate" };
    }

    const channelId = CATEGORY_CHANNEL[input.category];
    let sent = 0;
    let failed = 0;
    const invalid: string[] = [];
    const deliveredTokens: string[] = [];
    const tickets: Array<{ token: string; ticketId?: string }> = [];
    const errors: string[] = [];
    let httpStatus: number | undefined;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const messages: ExpoPushMessage[] = chunk.map((row) => ({
        to: row.token,
        title: input.title,
        body: input.body,
        data: { ...(input.data || {}), category: input.category },
        sound: "default",
        channelId,
        priority: "high",
        ttl: 60 * 60 * 24,
        icon: ANDROID_NOTIFICATION_ICON,
      }));

      const result = await postExpo(EXPO_PUSH_URL, messages);
      if (!result.ok) {
        httpStatus = result.status;
        failed += messages.length;
        errors.push(`http_${result.status}`);
        await db
          .update(pushToken)
          .set({ lastError: `send_${result.status}`, updatedAt: new Date() })
          .where(inArray(pushToken.token, messages.map((m) => m.to)));
        continue;
      }

      const ticketList: any[] = Array.isArray(result.json?.data) ? result.json.data : [];
      messages.forEach((message, index) => {
        const ticket = ticketList[index];
        if (ticket?.status === "ok") {
          sent += 1;
          deliveredTokens.push(message.to);
          if (ticket.id) tickets.push({ token: message.to, ticketId: ticket.id });
          return;
        }
        failed += 1;
        const errorCode = ticket?.details?.error;
        if (errorCode) errors.push(String(errorCode));
        // DeviceNotRegistered / InvalidCredentials never recover on their own.
        if (errorCode === "DeviceNotRegistered" || errorCode === "InvalidCredentials") {
          invalid.push(message.to);
        } else {
          db.update(pushToken)
            .set({ lastError: String(errorCode || "unknown"), updatedAt: new Date() })
            .where(eq(pushToken.token, message.to))
            .catch(() => undefined);
        }
      });
    }

    if (invalid.length) await deactivateTokens(invalid, "DeviceNotRegistered");
    if (deliveredTokens.length) {
      await db
        .update(pushToken)
        .set({ lastSuccessAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(inArray(pushToken.token, deliveredTokens));
    }

    if (logId) {
      await db
        .update(notificationLog)
        .set({ deliveries: sent, tickets: tickets.length ? tickets : null })
        .where(eq(notificationLog.id, logId));
      // Receipts are the only proof of delivery. Checking shortly after the
      // send catches the common "app was uninstalled" case without waiting for
      // the next maintenance sweep.
      if (tickets.length) setTimeout(() => void checkReceipts(logId!), 20_000).unref?.();
    }

    return { sent, failed, errors: errors.length ? errors : undefined, httpStatus };
  } catch {
    return { sent: 0, failed: 0 };
  }
}

/**
 * Fetches receipts for one log row and deactivates tokens Expo reports as
 * unregistered. Receipts are anonymous: they say nothing about the member.
 */
export async function checkReceipts(logId: string): Promise<void> {
  try {
    const row = await db.query.notificationLog.findFirst({
      where: eq(notificationLog.id, logId),
    });
    if (!row || !row.tickets?.length || row.receiptCheckedAt) return;

    const ids = row.tickets.map((t) => t.ticketId).filter(Boolean) as string[];
    if (!ids.length) return;

    const result = await postExpo(EXPO_RECEIPT_URL, { ids });
    if (!result.ok) return;

    const data = result.json?.data || {};
    const dead: string[] = [];
    for (const ticket of row.tickets) {
      const receipt = data[ticket.ticketId as string];
      if (receipt?.status === "error" && receipt?.details?.error === "DeviceNotRegistered") {
        dead.push(ticket.token);
      }
    }
    if (dead.length) await deactivateTokens(dead, "DeviceNotRegistered");

    await db
      .update(notificationLog)
      .set({ receiptCheckedAt: new Date() })
      .where(eq(notificationLog.id, logId));
  } catch {
    // A receipt check is best-effort; the sweep will retry.
  }
}

/** Sweeps log rows whose receipts were never fetched (for example after a deploy). */
export async function sweepPendingReceipts(): Promise<void> {
  const cutoff = new Date(Date.now() - 60_000);
  const rows = await db
    .select({ id: notificationLog.id })
    .from(notificationLog)
    .where(
      and(
        isNull(notificationLog.receiptCheckedAt),
        isNotNull(notificationLog.tickets),
        lt(notificationLog.createdAt, cutoff)
      )
    )
    .limit(100);

  for (const row of rows) await checkReceipts(row.id);
}

/** Starts the periodic receipt sweep. Called once from the server entry point. */
export function startPushReceiptWorker(): void {
  const timer = setInterval(() => {
    sweepPendingReceipts().catch(() => undefined);
    sendAppointmentReminders().catch(() => undefined);
  }, 5 * 60 * 1000);
  // Do not hold the process open just for this.
  timer.unref?.();
}

/**
 * Reminds members about confirmed visits happening roughly 24 hours from now.
 *
 * Runs on the same five-minute interval as the receipt sweep, so no extra
 * scheduler or paid cron service is needed. The dedupe key includes the date,
 * so a reminder is sent once per visit even though the sweep keeps running.
 */
export async function sendAppointmentReminders(): Promise<void> {
  const from = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24.5 * 60 * 60 * 1000);

  const upcoming = await db
    .select({
      id: appointment.id,
      userId: appointment.userId,
      slot: appointment.slot,
      isoStart: appointment.isoStart,
    })
    .from(appointment)
    .where(
      and(
        eq(appointment.status, "confirmed"),
        gte(appointment.isoStart, from),
        lte(appointment.isoStart, to)
      )
    )
    .limit(200);

  for (const row of upcoming) {
    const day = row.isoStart ? new Date(row.isoStart).toISOString().slice(0, 10) : "unknown";
    await sendPushToUser(row.userId, {
      category: "appointments",
      title: "Appointment tomorrow",
      body: `Your nutrition visit is coming up: ${row.slot}.`,
      data: { type: "appointment", appointmentId: row.id, screen: "AppointmentDetail" },
      dedupeKey: `appointment-reminder:${row.id}:${day}`,
    });
  }
}

import { db } from "../db/index.js";
import { pushToken } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";

interface PushMessageInput {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
  channelId?: string;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendPushToUser(
  userId: string,
  input: PushMessageInput
): Promise<{ sent: number; failed: number }> {
  const rows = await db
    .select({ token: pushToken.token })
    .from(pushToken)
    .where(eq(pushToken.userId, userId));

  if (rows.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const invalid: string[] = [];

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const messages: ExpoPushMessage[] = chunk.map((row) => ({
      to: row.token,
      title: input.title,
      body: input.body,
      data: input.data,
      sound: "default",
      channelId: "default",
    }));

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (process.env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      failed += messages.length;
      continue;
    }

    const payload: any = await response.json().catch(() => null);
    const tickets: any[] = Array.isArray(payload?.data) ? payload.data : [];

    messages.forEach((message, index) => {
      const ticket = tickets[index];
      if (ticket?.status === "ok") {
        sent += 1;
        return;
      }
      failed += 1;
      if (ticket?.details?.error === "DeviceNotRegistered") {
        invalid.push(message.to);
      }
    });
  }

  if (invalid.length) {
    await db.delete(pushToken).where(inArray(pushToken.token, invalid));
  }

  return { sent, failed };
}

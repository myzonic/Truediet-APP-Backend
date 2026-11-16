import { eq } from "drizzle-orm";
import { verifyJWT } from "./password.js";
import { drizzleDB } from "../db/index.js";
import { getUserById } from "../db/queries.js";
import { session } from "../db/schema.js";

/**
 * Resolves the current member from:
 * 1. `Authorization: Bearer <JWT or sessionToken>` header (mobile & web API)
 * 2. `truediet_session` HTTP-only cookie (browser / web fallback)
 *
 * Shared by every protected API route so all endpoints validate sessions the
 * same way (missing / invalid / expired token -> null).
 */
export async function getAuthUserFromRequest(c: any): Promise<any | null> {
  const authHeader = c.req.header("authorization") || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    const cookieHeader = c.req.header("cookie") || "";
    const match = cookieHeader.match(/(?:^|;\s*)truediet_session=([^;]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) return null;

  // 1. Signed JWT
  const payload = await verifyJWT(token);
  if (payload?.userId) {
    const userRecord = await getUserById(payload.userId);
    if (userRecord) return userRecord;
  }

  // 2. Opaque session token stored in the PostgreSQL `session` table
  try {
    const rows = await drizzleDB
      .select()
      .from(session)
      .where(eq(session.token, token))
      .limit(1);
    const s = rows[0];
    if (s && s.expiresAt && new Date(s.expiresAt) > new Date()) {
      const userRecord = await getUserById(s.userId);
      if (userRecord) return userRecord;
    }
  } catch {
    // ignore DB lookup failure
  }

  return null;
}

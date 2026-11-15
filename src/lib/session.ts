import { verifyJWT } from "./password.js";
import { getUserById } from "../db/queries.js";

// Resolves the current member from the bearer JWT on the custom auth backend.
// Shared by every protected API route so all endpoints validate sessions the
// same way (missing / invalid / expired token -> null).
export async function getAuthUserFromRequest(c: any): Promise<any | null> {
  const authHeader = c.req.header("authorization");
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = await verifyJWT(token);
  if (!payload) {
    return null;
  }
  const user = await getUserById(payload.userId);
  if (!user) {
    return null;
  }
  return user;
}

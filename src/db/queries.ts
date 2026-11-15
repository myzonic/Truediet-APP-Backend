import { db } from "./index.js";
import { user, session, profile } from "./schema.js";
import { eq } from "drizzle-orm";
import { hashPassword } from "../lib/password.js";

// Get user by email
export async function getUserByEmail(email: string) {
  const result = await db.select().from(user).where(eq(user.email, email.trim().toLowerCase()));
  return result[0] || null;
}

// Get user by ID
export async function getUserById(userId: string) {
  const result = await db.select().from(user).where(eq(user.id, userId));
  return result[0] || null;
}

// Get profile by user ID
export async function getProfileByUserId(userId: string) {
  const result = await db.select().from(profile).where(eq(profile.userId, userId));
  return result[0] || null;
}

// Create a new user
export async function createUser(name: string, email: string, password: string) {
  const hashedPassword = await hashPassword(password);
  
  const [newUser] = await db.insert(user).values({
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    emailVerified: false,
    password: hashedPassword,
  }).returning();
  
  // Create profile
  await db.insert(profile).values({
    userId: newUser.id,
    displayName: name.trim(),
  });
  
  return newUser;
}

// Create a session
export async function createSession(userId: string, ipAddress: string, userAgent: string) {
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  const [newSession] = await db.insert(session).values({
    id: crypto.randomUUID(),
    expiresAt,
    token: sessionToken,
    userId,
    ipAddress,
    userAgent,
  }).returning();
  
  return newSession;
}

// Revoke a session
export async function revokeSession(token: string) {
  await db.delete(session).where(eq(session.token, token));
}

// Get user's active sessions
export async function getUserSessions(userId: string) {
  return db.select().from(session).where(eq(session.userId, userId));
}
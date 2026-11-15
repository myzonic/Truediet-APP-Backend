import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { drizzleDB } from "../db/index.js";
import { hashPassword, verifyPassword, createJWT, verifyJWT } from "../lib/password.js";
import { getUserByEmail, getUserById } from "../db/queries.js";
import { user, session, profile, verification } from "../db/schema.js";
import { sendAuthEmail, isEmailConfigured } from "../lib/email.js";
import { passwordResetEmail } from "../lib/email-templates.js";

const auth = new Hono();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Helper: generate a secure random token
function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(36)).join("").substring(0, 48);
}

// Helper: resolve the current user from the Bearer JWT.
// Returns the user record, or null when the token is missing/invalid/expired.
async function requireAuthUser(c: any): Promise<any | null> {
  const authHeader = c.req.header("authorization");
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = await verifyJWT(token);
  if (!payload) {
    return null;
  }
  const userRecord = await getUserById(payload.userId);
  if (!userRecord) {
    return null;
  }
  return userRecord;
}

// POST /api/auth/register
auth.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, password } = body;

    if (!name || !email || !password) {
      return c.json({ error: "validation_error", message: "Name, email and password are required" }, 400);
    }

    if (password.length < 8) {
      return c.json({ error: "validation_error", message: "Password must be at least 8 characters" }, 400);
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedName = String(name).trim();

    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) {
      return c.json({ error: "user_exists", message: "An account with this email already exists" }, 409);
    }

    const hashedPassword = await hashPassword(String(password));

    const userId = crypto.randomUUID();
    await drizzleDB.insert(user).values({
      id: userId,
      name: normalizedName,
      email: normalizedEmail,
      emailVerified: false,
      password: hashedPassword,
    });

    await drizzleDB.insert(profile).values({
      userId: userId,
      displayName: normalizedName,
    });

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await drizzleDB.insert(session).values({
      id: crypto.randomUUID(),
      expiresAt,
      token: sessionToken,
      userId,
      ipAddress: c.req.header("x-forwarded-for") || c.req.header("remote-addr") || "",
      userAgent: c.req.header("user-agent") || "",
    });

    const token = await createJWT(userId, normalizedEmail);

    return c.json({
      user: {
        id: userId,
        name: normalizedName,
        email: normalizedEmail,
      },
      session: {
        token: sessionToken,
        expiresAt: expiresAt,
      },
      token,
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/login
auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "validation_error", message: "Email and password are required" }, 400);
    }

    const userRecord = await getUserByEmail(String(email).trim().toLowerCase());
    if (!userRecord) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }

    const passwordValid = await verifyPassword(String(password), userRecord.password || "");
    if (!passwordValid) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await drizzleDB.insert(session).values({
      id: crypto.randomUUID(),
      expiresAt,
      token: sessionToken,
      userId: userRecord.id,
      ipAddress: c.req.header("x-forwarded-for") || c.req.header("remote-addr") || "",
      userAgent: c.req.header("user-agent") || "",
    });

    const token = await createJWT(userRecord.id, userRecord.email);

    return c.json({
      user: {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
      },
      session: {
        token: sessionToken,
        expiresAt: expiresAt,
      },
      token,
    });
  } catch (error: any) {
    console.error("Login error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/logout
auth.post("/logout", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { token } = body;

    if (token) {
      await drizzleDB.delete(session).where(eq(session.token, token));
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Logout error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/logout-all
auth.post("/logout-all", async (c) => {
  const currentUser = await requireAuthUser(c);
  if (!currentUser) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    await drizzleDB.delete(session).where(eq(session.userId, currentUser.id));
    return c.json({ success: true });
  } catch (error: any) {
    console.error("Logout all error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/refresh
auth.post("/refresh", async (c) => {
  try {
    const body = await c.req.json();
    const { token } = body;

    if (!token) {
      return c.json({ error: "invalid_token", message: "Token is required" }, 401);
    }

    const payload = await verifyJWT(token);
    if (!payload) {
      return c.json({ error: "invalid_token", message: "Invalid or expired token" }, 401);
    }

    const userRecord = await getUserById(payload.userId);
    if (!userRecord) {
      return c.json({ error: "user_not_found", message: "User not found" }, 404);
    }

    const newJWT = await createJWT(userRecord.id, userRecord.email);

    return c.json({ token: newJWT });
  } catch (error: any) {
    console.error("Refresh error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// GET /api/auth/me
auth.get("/me", async (c) => {
  const userRecord = await requireAuthUser(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  return c.json({
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
    },
  });
});

// GET /api/auth/session
auth.get("/session", async (c) => {
  const userRecord = await requireAuthUser(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  const token = await createJWT(userRecord.id, userRecord.email);

  return c.json({
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
    },
    session: {
      userId: userRecord.id,
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
});

// POST /api/auth/verify-email
auth.post("/verify-email", async (c) => {
  try {
    const body = await c.req.json();
    const { email, token } = body;

    if (!email || !token) {
      return c.json({ error: "validation_error", message: "Email and token are required" }, 400);
    }

    const rows = await drizzleDB.select().from(verification).where(
      and(
        eq(verification.identifier, String(email).trim().toLowerCase()),
        eq(verification.value, token)
      )
    );
    const verificationRow = rows[0];
    const now = new Date();
    if (!verificationRow || verificationRow.expiresAt < now) {
      return c.json({ error: "invalid_token", message: "This verification link is invalid or has expired" }, 400);
    }

    await drizzleDB
      .update(user)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(user.email, String(email).trim().toLowerCase()));

    await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Verify email error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/verify-email/confirm
auth.post("/verify-email/confirm", async (c) => {
  try {
    const body = await c.req.json();
    const { token } = body;

    if (!token) {
      return c.json({ error: "validation_error", message: "Token is required" }, 400);
    }

    const rows = await drizzleDB.select().from(verification).where(eq(verification.value, token));
    const verificationRow = rows[0];
    const now = new Date();
    if (!verificationRow || verificationRow.expiresAt < now) {
      return c.json({ error: "invalid_token", message: "This verification link is invalid or has expired" }, 400);
    }

    await drizzleDB
      .update(user)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(user.email, verificationRow.identifier));

    await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Verify email error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/forgot-password
auth.post("/forgot-password", async (c) => {
  try {
    const body = await c.req.json();
    const { email } = body;

    if (!email) {
      return c.json({ error: "validation_error", message: "Email is required" }, 400);
    }

    const userRecord = await getUserByEmail(String(email).trim().toLowerCase());
    if (!userRecord) {
      // Do not reveal whether the account exists.
      return c.json({ success: true });
    }

    const resetToken = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await drizzleDB.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: userRecord.email,
      value: resetToken,
      expiresAt,
    });

    const template = passwordResetEmail(userRecord.name, `/reset?token=${encodeURIComponent(resetToken)}`, RESET_TOKEN_TTL_MS / 60);

    const result = await sendAuthEmail({
      to: userRecord.email,
      subject: template.subject,
      text: template.text,
      html: template.html,
    });

    if (!result.ok) {
      console.error(`[auth] password reset email failed for ${userRecord.email}:`, result.error);
    }

    const payload: Record<string, unknown> = { success: true };
    if (!isEmailConfigured()) {
      // Only surface the token outside of a configured mail transport so the
      // deep link flow can be exercised end to end in development.
      payload.resetToken = resetToken;
    }

    return c.json(payload);
  } catch (error: any) {
    console.error("Forgot password error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/reset-password
auth.post("/reset-password", async (c) => {
  try {
    const body = await c.req.json();
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return c.json({ error: "validation_error", message: "Token and new password are required" }, 400);
    }

    if (newPassword.length < 8) {
      return c.json({ error: "validation_error", message: "Password must be at least 8 characters" }, 400);
    }

    const rows = await drizzleDB.select().from(verification).where(eq(verification.value, token));
    const verificationRow = rows[0];
    const now = new Date();
    if (!verificationRow || verificationRow.expiresAt < now) {
      return c.json({ error: "invalid_token", message: "This reset link is invalid or has expired" }, 400);
    }

    const userRecord = await getUserByEmail(verificationRow.identifier);
    if (!userRecord) {
      return c.json({ error: "user_not_found", message: "User not found" }, 404);
    }

    const hashedPassword = await hashPassword(newPassword);
    await drizzleDB.update(user).set({ password: hashedPassword, updatedAt: new Date() }).where(eq(user.id, userRecord.id));
    await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));

    // A password reset signs the member out everywhere.
    await drizzleDB.delete(session).where(eq(session.userId, userRecord.id));

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Reset password error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/change-password
auth.post("/change-password", async (c) => {
  const userRecord = await requireAuthUser(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const body = await c.req.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return c.json({ error: "validation_error", message: "Current and new passwords are required" }, 400);
    }
    if (newPassword.length < 8) {
      return c.json({ error: "validation_error", message: "Password must be at least 8 characters" }, 400);
    }

    const passwordValid = await verifyPassword(currentPassword, userRecord.password || "");
    if (!passwordValid) {
      return c.json({ error: "invalid_password", message: "Your current password is incorrect" }, 400);
    }

    const hashedPassword = await hashPassword(newPassword);
    await drizzleDB.update(user).set({ password: hashedPassword, updatedAt: new Date() }).where(eq(user.id, userRecord.id));

    // Changing a password should end sessions that may be compromised.
    await drizzleDB.delete(session).where(eq(session.userId, userRecord.id));

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Change password error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// GET /api/auth/sessions
auth.get("/sessions", async (c) => {
  const userRecord = await requireAuthUser(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const sessions = await drizzleDB.select().from(session).where(eq(session.userId, userRecord.id));
    return c.json({ sessions });
  } catch (error: any) {
    console.error("Sessions error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// DELETE /api/auth/sessions/:id
auth.delete("/sessions/:id", async (c) => {
  const userRecord = await requireAuthUser(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const sessionId = c.req.param("id");
    const sessions = await drizzleDB.select().from(session).where(eq(session.id, sessionId));
    const target = sessions[0];
    if (!target || target.userId !== userRecord.id) {
      return c.json({ error: "not_found", message: "Session not found" }, 404);
    }

    await drizzleDB.delete(session).where(eq(session.id, sessionId));
    return c.json({ success: true });
  } catch (error: any) {
    console.error("Session delete error:", error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

export default auth;

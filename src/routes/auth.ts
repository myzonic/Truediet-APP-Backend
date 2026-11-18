import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { drizzleDB } from "../db/index.js";
import { hashPassword, verifyPassword, createJWT, verifyJWT } from "../lib/password.js";
import { getUserByEmail, getUserById } from "../db/queries.js";
import { user, session, profile, verification, account } from "../db/schema.js";
import { sendAuthEmail, isEmailConfigured, describeTransport } from "../lib/email.js";
import { passwordResetEmail, emailVerificationEmail } from "../lib/email-templates.js";
import { getAuthUserFromRequest } from "../lib/session.js";

const auth = new Hono();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function envFlag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function emailVerificationEnabled(): boolean {
  return envFlag(process.env.EMAIL_VERIFICATION_ENABLED);
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(36).padStart(2, "0")).join("").substring(0, 48);
}

function getPublicOrigin(c: any): string {
  const configured = (process.env.AUTH_PUBLIC_URL || process.env.BETTER_AUTH_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "https://api.true-diet.com";
  }
}

function setSessionCookie(c: any, jwt: string, maxAgeSeconds = 7 * 24 * 60 * 60): void {
  const isSecure = getPublicOrigin(c).startsWith("https://");
  const parts = [
    `truediet_session=${encodeURIComponent(jwt)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(c: any): void {
  c.header("Set-Cookie", "truediet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

async function createAndSendVerificationEmail(
  c: any,
  userRecord: { id: string; name: string; email: string }
): Promise<{ sent: boolean; verifyToken?: string; error?: string }> {
  const verifyToken = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  await drizzleDB.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: userRecord.email.toLowerCase(),
    value: verifyToken,
    expiresAt,
  });

  const link = `${getPublicOrigin(c)}/verify-email?token=${encodeURIComponent(verifyToken)}`;
  const template = emailVerificationEmail(userRecord.name, link, 60);

  if (!isEmailConfigured()) {
    return { sent: false, verifyToken, error: "email_not_configured" };
  }

  const result = await sendAuthEmail({
    to: userRecord.email,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });

  if (result.ok) {
    console.log(
      `[email] verification email queued to ${userRecord.email} (${describeTransport().mode}${
        result.messageId ? `, messageId ${result.messageId}` : ""
      })`
    );
    return { sent: true };
  }

  console.error(`[email] verification email FAILED for ${userRecord.email}: ${result.error}`);
  return { sent: false, error: result.error };
}

async function issueUserSession(
  c: any,
  userRecord: { id: string; name: string; email: string; image?: string | null; emailVerified?: boolean }
) {
  const sessionId = crypto.randomUUID();
  const sessionToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await drizzleDB.insert(session).values({
    id: sessionId,
    expiresAt,
    token: sessionToken,
    userId: userRecord.id,
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("remote-addr") || "",
    userAgent: c.req.header("user-agent") || "",
  });

  const token = await createJWT(userRecord.id, userRecord.email);
  setSessionCookie(c, token);

  return {
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image || null,
      emailVerified: Boolean(userRecord.emailVerified),
    },
    session: {
      id: sessionId,
      userId: userRecord.id,
      token: sessionToken,
      expiresAt,
    },
    token,
  };
}

// POST /api/auth/register
auth.post("/register", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { name, email, password } = body;

    if (!name || !email || !password) {
      return c.json({ error: "validation_error", message: "Name, email and password are required" }, 400);
    }

    if (String(password).length < 8) {
      return c.json({ error: "validation_error", message: "Password must be at least 8 characters" }, 400);
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedName = String(name).trim();

    if (!normalizedEmail.includes("@") || normalizedName.length < 2) {
      return c.json({ error: "validation_error", message: "Provide a valid full name and email address" }, 400);
    }

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

    await drizzleDB
      .insert(profile)
      .values({
        userId,
        displayName: normalizedName,
      })
      .onConflictDoNothing({ target: profile.userId });

    // Also maintain a credential account row for schema consistency
    await drizzleDB.insert(account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hashedPassword,
    });

    const issued = await issueUserSession(c, {
      id: userId,
      name: normalizedName,
      email: normalizedEmail,
      emailVerified: false,
    });

    // Send verification email if enabled or configured
    let verificationDispatched = false;
    if (emailVerificationEnabled() || isEmailConfigured()) {
      const vRes = await createAndSendVerificationEmail(c, {
        id: userId,
        name: normalizedName,
        email: normalizedEmail,
      });
      verificationDispatched = vRes.sent;
    }

    return c.json({
      ...issued,
      verificationEmailSent: verificationDispatched,
    });
  } catch (error: any) {
    console.error("Registration error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/login
auth.post("/login", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "validation_error", message: "Email and password are required" }, 400);
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const userRecord = await getUserByEmail(normalizedEmail);
    if (!userRecord) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }

    // Check user.password first, then fallback to account.password for legacy rows
    let storedHash = userRecord.password || "";
    if (!storedHash) {
      const accRows = await drizzleDB
        .select()
        .from(account)
        .where(and(eq(account.userId, userRecord.id), eq(account.providerId, "credential")))
        .limit(1);
      storedHash = accRows[0]?.password || "";
    }

    if (!storedHash) {
      return c.json(
        {
          error: "invalid_credentials",
          message: "This account uses Google Sign-In or has not set a password yet. Use Google Sign-In or Forgot Password.",
        },
        401
      );
    }

    const passwordValid = await verifyPassword(String(password), storedHash);
    if (!passwordValid) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }

    // Upgrade legacy scrypt hash to bcrypt transparently on sign-in
    if (!storedHash.startsWith("$2")) {
      const upgraded = await hashPassword(String(password));
      await drizzleDB
        .update(user)
        .set({ password: upgraded, updatedAt: new Date() })
        .where(eq(user.id, userRecord.id));
    }

    const issued = await issueUserSession(c, userRecord);
    return c.json(issued);
  } catch (error: any) {
    console.error("Login error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/logout
auth.post("/logout", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { token } = body;

    if (token) {
      await drizzleDB.delete(session).where(eq(session.token, String(token)));
    }
    clearSessionCookie(c);
    return c.json({ success: true });
  } catch (error: any) {
    console.error("Logout error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/logout-all
auth.post("/logout-all", async (c) => {
  const currentUser = await getAuthUserFromRequest(c);
  if (!currentUser) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    await drizzleDB.delete(session).where(eq(session.userId, currentUser.id));
    clearSessionCookie(c);
    return c.json({ success: true });
  } catch (error: any) {
    console.error("Logout all error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/refresh
auth.post("/refresh", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { token } = body;

    if (!token) {
      return c.json({ error: "invalid_token", message: "Token is required" }, 401);
    }

    const payload = await verifyJWT(String(token));
    if (!payload) {
      return c.json({ error: "invalid_token", message: "Invalid or expired token" }, 401);
    }

    const userRecord = await getUserById(payload.userId);
    if (!userRecord) {
      return c.json({ error: "user_not_found", message: "User not found" }, 404);
    }

    const newJWT = await createJWT(userRecord.id, userRecord.email);
    setSessionCookie(c, newJWT);
    return c.json({ token: newJWT });
  } catch (error: any) {
    console.error("Refresh error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// GET /api/auth/me
auth.get("/me", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  return c.json({
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
      emailVerified: Boolean(userRecord.emailVerified),
    },
  });
});

// GET /api/auth/session
auth.get("/session", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  const token = await createJWT(userRecord.id, userRecord.email);
  setSessionCookie(c, token);

  return c.json({
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
      emailVerified: Boolean(userRecord.emailVerified),
    },
    session: {
      id: userRecord.id,
      userId: userRecord.id,
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
});

// PATCH /api/auth/profile -> update user's full name
auth.patch("/profile", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length < 2) {
      return c.json({ error: "validation_error", message: "Name must be at least 2 characters" }, 400);
    }

    const [updated] = await drizzleDB
      .update(user)
      .set({ name, updatedAt: new Date() })
      .where(eq(user.id, userRecord.id))
      .returning();

    await drizzleDB
      .update(profile)
      .set({ displayName: name, updatedAt: new Date() })
      .where(eq(profile.userId, userRecord.id));

    return c.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        image: updated.image,
        emailVerified: Boolean(updated.emailVerified),
      },
    });
  } catch (error: any) {
    console.error("Update profile error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// ==========================================
// Email Verification
// ==========================================

async function verifyTokenAndMarkEmailVerified(token: string) {
  const rows = await drizzleDB.select().from(verification).where(eq(verification.value, token));
  const verificationRow = rows[0];
  const now = new Date();
  if (!verificationRow) {
    return { ok: false, code: "INVALID_TOKEN", message: "This verification link is invalid or has already been used." };
  }
  if (verificationRow.expiresAt < now) {
    await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));
    return { ok: false, code: "TOKEN_EXPIRED", message: "This verification link has expired. Request a new one from the app." };
  }

  const targetUser = await getUserByEmail(verificationRow.identifier.toLowerCase());
  if (!targetUser) {
    return { ok: false, code: "USER_NOT_FOUND", message: "This account no longer exists." };
  }

  await drizzleDB
    .update(user)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(user.id, targetUser.id));

  await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));
  return { ok: true, alreadyVerified: Boolean(targetUser.emailVerified), email: targetUser.email };
}

// GET /api/auth/verify-email?token=... (used by the web page at /verify-email)
auth.get("/verify-email", async (c) => {
  const token = (c.req.query("token") || "").trim();
  if (!token) {
    return c.json({ status: false, success: false, code: "INVALID_TOKEN", message: "Token is required" }, 400);
  }
  try {
    const res = await verifyTokenAndMarkEmailVerified(token);
    if (!res.ok) {
      return c.json({ status: false, success: false, code: res.code, message: res.message }, 400);
    }
    return c.json({ status: true, success: true, alreadyVerified: res.alreadyVerified });
  } catch (error: any) {
    console.error("Verify email GET error:", error?.message || error);
    return c.json({ status: false, success: false, message: "Could not verify email." }, 500);
  }
});

// POST /api/auth/verify-email -> either sends a verification email (when only `email` is provided)
// or verifies a token (when `token` is provided).
auth.post("/verify-email", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, token } = body;

    // Mode 1: Confirm token if token is supplied
    if (token) {
      const res = await verifyTokenAndMarkEmailVerified(String(token).trim());
      if (!res.ok) {
        return c.json({ status: false, success: false, code: res.code, error: res.code, message: res.message }, 400);
      }
      return c.json({ status: true, success: true, alreadyVerified: res.alreadyVerified });
    }

    // Mode 2: Send / resend verification email to `email`
    if (!email) {
      return c.json({ error: "validation_error", message: "Email is required" }, 400);
    }

    if (!isEmailConfigured()) {
      return c.json(
        {
          error: "email_not_configured",
          code: "EMAIL_NOT_CONFIGURED",
          message: "Email delivery is not configured on this server. Set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY.",
        },
        503
      );
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const userRecord = await getUserByEmail(normalizedEmail);
    if (!userRecord) {
      // Do not leak account existence
      return c.json({ status: true, success: true });
    }

    if (userRecord.emailVerified) {
      return c.json({ status: true, success: true, alreadyVerified: true });
    }

    const vRes = await createAndSendVerificationEmail(c, userRecord);
    if (!vRes.sent) {
      return c.json({ error: "email_failed", message: "Could not send verification email. Please try again." }, 502);
    }

    return c.json({ status: true, success: true });
  } catch (error: any) {
    console.error("Verify email POST error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/verify-email/confirm -> explicit token confirmation endpoint
auth.post("/verify-email/confirm", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const token = String(body?.token || "").trim();
    if (!token) {
      return c.json({ error: "validation_error", message: "Token is required" }, 400);
    }

    const res = await verifyTokenAndMarkEmailVerified(token);
    if (!res.ok) {
      return c.json({ status: false, success: false, code: res.code, error: res.code, message: res.message }, 400);
    }

    return c.json({ status: true, success: true, alreadyVerified: res.alreadyVerified });
  } catch (error: any) {
    console.error("Verify email confirm error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// ==========================================
// Password Reset
// ==========================================

// POST /api/auth/forgot-password
auth.post("/forgot-password", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email } = body;

    if (!email) {
      return c.json({ error: "validation_error", message: "Email is required" }, 400);
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const userRecord = await getUserByEmail(normalizedEmail);
    if (!userRecord) {
      // Do not reveal whether the account exists.
      return c.json({ status: true, success: true });
    }

    const resetToken = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await drizzleDB.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: userRecord.email.toLowerCase(),
      value: resetToken,
      expiresAt,
    });

    const fullResetUrl = `${getPublicOrigin(c)}/reset?token=${encodeURIComponent(resetToken)}`;
    const template = passwordResetEmail(userRecord.name, fullResetUrl, RESET_TOKEN_TTL_MS / 60000);

    if (isEmailConfigured()) {
      const result = await sendAuthEmail({
        to: userRecord.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });

      if (!result.ok) {
        console.error(`[auth] password reset email failed for ${userRecord.email}:`, result.error);
        return c.json({ error: "email_failed", message: "Could not send password reset email. Please try again." }, 502);
      }
    }

    const payload: Record<string, unknown> = { status: true, success: true };
    // Only expose the reset token outside production, and never when email is
    // configured. Returning it whenever email was unconfigured leaked a usable
    // reset token to anyone who knew an email address.
    if (process.env.NODE_ENV !== "production" && !isEmailConfigured()) {
      payload.resetToken = resetToken;
    }

    return c.json(payload);
  } catch (error: any) {
    console.error("Forgot password error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/reset-password
auth.post("/reset-password", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return c.json(
        { status: false, success: false, code: "INVALID_TOKEN", error: "validation_error", message: "Token and new password are required" },
        400
      );
    }

    if (String(newPassword).length < 8) {
      return c.json(
        { status: false, success: false, error: "validation_error", message: "Password must be at least 8 characters" },
        400
      );
    }

    const rows = await drizzleDB.select().from(verification).where(eq(verification.value, String(token).trim()));
    const verificationRow = rows[0];
    const now = new Date();
    if (!verificationRow) {
      return c.json(
        { status: false, success: false, code: "INVALID_TOKEN", error: "invalid_token", message: "This reset link is invalid or has already been used." },
        400
      );
    }
    if (verificationRow.expiresAt < now) {
      await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));
      return c.json(
        { status: false, success: false, code: "TOKEN_EXPIRED", error: "invalid_token", message: "This reset link has expired. Request a new reset link from the app." },
        400
      );
    }

    const userRecord = await getUserByEmail(verificationRow.identifier.toLowerCase());
    if (!userRecord) {
      return c.json({ status: false, success: false, code: "USER_NOT_FOUND", error: "user_not_found", message: "User not found" }, 404);
    }

    const hashedPassword = await hashPassword(String(newPassword));
    await drizzleDB
      .update(user)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(user.id, userRecord.id));

    await drizzleDB.delete(verification).where(eq(verification.id, verificationRow.id));

    // A password reset signs the member out everywhere.
    await drizzleDB.delete(session).where(eq(session.userId, userRecord.id));

    return c.json({ status: true, success: true });
  } catch (error: any) {
    console.error("Reset password error:", error?.message || error);
    return c.json({ status: false, success: false, error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// POST /api/auth/change-password
auth.post("/change-password", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return c.json({ error: "validation_error", message: "Current and new passwords are required" }, 400);
    }
    if (String(newPassword).length < 8) {
      return c.json({ error: "validation_error", message: "Password must be at least 8 characters" }, 400);
    }

    let storedHash = userRecord.password || "";
    if (!storedHash) {
      const accRows = await drizzleDB
        .select()
        .from(account)
        .where(and(eq(account.userId, userRecord.id), eq(account.providerId, "credential")))
        .limit(1);
      storedHash = accRows[0]?.password || "";
    }

    if (!storedHash) {
      return c.json(
        { error: "no_password", message: "This account signs in with Google and does not have a password to change." },
        400
      );
    }

    const passwordValid = await verifyPassword(String(currentPassword), storedHash);
    if (!passwordValid) {
      return c.json({ error: "invalid_password", message: "Your current password is incorrect" }, 400);
    }

    const hashedPassword = await hashPassword(String(newPassword));
    await drizzleDB.update(user).set({ password: hashedPassword, updatedAt: new Date() }).where(eq(user.id, userRecord.id));

    // Revoke existing sessions and issue a fresh token for the active device
    await drizzleDB.delete(session).where(eq(session.userId, userRecord.id));
    const issued = await issueUserSession(c, userRecord);

    return c.json({ success: true, ...issued });
  } catch (error: any) {
    console.error("Change password error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// ==========================================
// Direct Google OAuth 2.0 (No Better Auth)
// ==========================================

function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getGoogleCallbackUrl(c: any): string {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI.trim();
  }
  return `${getPublicOrigin(c)}/api/auth/google/callback`;
}

// GET /api/auth/google/start?redirect_uri=truediet://auth-callback
auth.get("/google/start", async (c) => {
  if (!isGoogleConfigured()) {
    return c.json(
      {
        error: "google_not_configured",
        message: "Google Sign-In is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      },
      503
    );
  }

  const appRedirect = (c.req.query("redirect_uri") || "truediet://auth-callback").trim();
  // Only allow safe app deep links or same-origin redirects
  const allowedAppRedirect =
    appRedirect.startsWith("truediet://") ||
    appRedirect.startsWith("com.truediet.truedietwelcome://") ||
    appRedirect.startsWith("exp://") ||
    appRedirect.startsWith("http://localhost:");
  const safeRedirect = allowedAppRedirect ? appRedirect : "truediet://auth-callback";

  const state = generateToken();
  await drizzleDB.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: `google_oauth:${state}`,
    value: safeRedirect,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!.trim());
  googleAuthUrl.searchParams.set("redirect_uri", getGoogleCallbackUrl(c));
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", state);
  googleAuthUrl.searchParams.set("prompt", "select_account");

  return c.redirect(googleAuthUrl.toString(), 302);
});

// GET /api/auth/google/callback?code=...&state=...
auth.get("/google/callback", async (c) => {
  const code = (c.req.query("code") || "").trim();
  const state = (c.req.query("state") || "").trim();
  const oauthError = (c.req.query("error") || "").trim();

  // Look up the stored state & app redirect URI
  let appRedirect = "truediet://auth-callback";
  if (state) {
    const stateRows = await drizzleDB
      .select()
      .from(verification)
      .where(eq(verification.identifier, `google_oauth:${state}`))
      .limit(1);
    const stateRow = stateRows[0];
    if (stateRow) {
      appRedirect = stateRow.value || appRedirect;
      await drizzleDB.delete(verification).where(eq(verification.id, stateRow.id));
      if (stateRow.expiresAt < new Date()) {
        return c.redirect(`${appRedirect}?error=${encodeURIComponent("Google sign-in session expired. Please try again.")}`, 302);
      }
    } else {
      return c.redirect(`${appRedirect}?error=${encodeURIComponent("Invalid OAuth state. Please try again.")}`, 302);
    }
  }

  if (oauthError || !code) {
    const msg = oauthError === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in did not complete.";
    return c.redirect(`${appRedirect}?error=${encodeURIComponent(msg)}`, 302);
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
        client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
        redirect_uri: getGoogleCallbackUrl(c),
        grant_type: "authorization_code",
      }).toString(),
    });

    const tokenData: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[google-oauth] token exchange failed:", tokenRes.status);
      return c.redirect(`${appRedirect}?error=${encodeURIComponent("Could not verify Google credentials.")}`, 302);
    }

    // Fetch Google user profile
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const gUser: any = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok || !gUser.email || !gUser.sub) {
      return c.redirect(`${appRedirect}?error=${encodeURIComponent("Google did not return an email address.")}`, 302);
    }

    const email = String(gUser.email).trim().toLowerCase();
    const googleSub = String(gUser.sub);
    const displayName = String(gUser.name || email.split("@")[0]).trim();
    const picture = typeof gUser.picture === "string" ? gUser.picture : null;

    // 1. Check if a Google account link already exists
    const existingGoogleAccount = await drizzleDB
      .select()
      .from(account)
      .where(and(eq(account.providerId, "google"), eq(account.accountId, googleSub)))
      .limit(1);

    let targetUser = existingGoogleAccount[0]
      ? await getUserById(existingGoogleAccount[0].userId)
      : null;

    // 2. Otherwise check if a user with this email exists and link safely
    if (!targetUser) {
      targetUser = await getUserByEmail(email);
      if (targetUser) {
        await drizzleDB
          .update(user)
          .set({
            emailVerified: true,
            image: targetUser.image || picture,
            updatedAt: new Date(),
          })
          .where(eq(user.id, targetUser.id));
      } else {
        // 3. First-time Google user: create user + profile
        const newUserId = crypto.randomUUID();
        const [createdUser] = await drizzleDB
          .insert(user)
          .values({
            id: newUserId,
            name: displayName,
            email,
            emailVerified: true,
            image: picture,
          })
          .returning();
        targetUser = createdUser;

        await drizzleDB
          .insert(profile)
          .values({
            userId: newUserId,
            displayName,
          })
          .onConflictDoNothing({ target: profile.userId });
      }

      // Link Google account record
      await drizzleDB.insert(account).values({
        id: crypto.randomUUID(),
        accountId: googleSub,
        providerId: "google",
        userId: targetUser.id,
        accessToken: tokenData.access_token,
        idToken: tokenData.id_token || null,
      });
    }

    const issued = await issueUserSession(c, targetUser);
    const sep = appRedirect.includes("?") ? "&" : "?";
    const redirectTarget =
      `${appRedirect}${sep}token=${encodeURIComponent(issued.token)}` +
      `&sessionToken=${encodeURIComponent(issued.session.token)}`;

    return c.redirect(redirectTarget, 302);
  } catch (error: any) {
    console.error("[google-oauth] callback error:", error?.message || error);
    return c.redirect(`${appRedirect}?error=${encodeURIComponent("Google sign-in failed. Please try again.")}`, 302);
  }
});

// GET /api/auth/sessions
auth.get("/sessions", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
  if (!userRecord) {
    return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  try {
    const sessions = await drizzleDB.select().from(session).where(eq(session.userId, userRecord.id));
    return c.json({ sessions });
  } catch (error: any) {
    console.error("Sessions error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

// DELETE /api/auth/sessions/:id
auth.delete("/sessions/:id", async (c) => {
  const userRecord = await getAuthUserFromRequest(c);
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
    console.error("Session delete error:", error?.message || error);
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again." }, 500);
  }
});

export default auth;

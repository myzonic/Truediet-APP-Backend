import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { sendAuthEmail, isEmailConfigured, describeTransport } from "./email.js";
import { passwordResetEmail, emailVerificationEmail } from "./email-templates.js";

const trustedOrigins = (process.env.TRUSTED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Better Auth builds its own callback URL from BETTER_AUTH_URL. Deriving the
// origin from that link means the emailed link always points at the same host
// the API runs on - no separate "reset domain" can drift out of sync.
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return (process.env.BETTER_AUTH_URL || "").replace(/\/+$/, "");
  }
}

/** Reset links are valid for one hour; the token is single use. */
const RESET_TOKEN_TTL_SECONDS = 3600;

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Explicit so the lifetime is a documented value rather than an implicit
    // default. The token row lives in `verification` and is deleted on use.
    resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
    // Every session issued before the reset stops working, so a password
    // change takes effect everywhere.
    revokeSessionsOnPasswordReset: true,

    sendResetPassword: async ({ user, url, token }) => {
      const link = `${originOf(url)}/reset?token=${encodeURIComponent(token)}`;
      const template = passwordResetEmail(user.name, link, RESET_TOKEN_TTL_SECONDS / 60);

      const result = await sendAuthEmail({
        to: user.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });

      // Only connection metadata and a message id are logged - never the
      // link, the token or the SMTP password.
      if (result.ok) {
        console.log(
          `[email] password reset queued to ${user.email} (${describeTransport().mode}${
            result.messageId ? `, messageId ${result.messageId}` : ""
          })`
        );
      } else {
        console.error(`[email] password reset FAILED for ${user.email}: ${result.error}`);
      }
    },
  },

  emailVerification: {
    expiresIn: RESET_TOKEN_TTL_SECONDS,
    sendVerificationEmail: async ({ user, url, token }) => {
      const link = `${originOf(url)}/verify-email?token=${encodeURIComponent(token)}`;
      const template = emailVerificationEmail(user.name, link, RESET_TOKEN_TTL_SECONDS / 60);

      const result = await sendAuthEmail({
        to: user.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });

      if (result.ok) {
        console.log(
          `[email] verification email queued to ${user.email} (${describeTransport().mode}${
            result.messageId ? `, messageId ${result.messageId}` : ""
          })`
        );
      } else {
        console.error(`[email] verification email FAILED for ${user.email}: ${result.error}`);
      }
    },
    // Verification emails are NOT sent on sign-up and verification is NOT
    // required to sign in, until the flow has been tested and explicitly
    // approved. Enable sending (still optional) with EMAIL_VERIFICATION_ENABLED=true.
    // requireEmailVerification stays unset on purpose: enabling it would lock
    // out every existing user whose email has never been verified.
    ...(process.env.EMAIL_VERIFICATION_ENABLED === "true" ? { sendOnSignUp: true } : {}),
  },

  socialProviders: {
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },
  trustedOrigins: [
    "http://localhost:8081",
    "http://localhost:19006",
    "exp://*",
    "truediet://*",
    ...trustedOrigins,
  ],
  plugins: [expo()],
});

// Reported once at boot so the operator can see whether auth email is usable.
// Prints host/port/from only - never a credential or a token.
console.log(`[email] ${isEmailConfigured() ? "configured" : "NOT configured"} - ${describeTransport().mode}`);

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

/**
 * Env switches accept true/1/yes/on in any case. Dokploy values are typed by
 * hand, and a "True" that silently behaves as false is a trap.
 */
export function envFlag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Whether sign-up sends the confirmation email (EMAIL_VERIFICATION_ENABLED). */
export function emailVerificationEnabled(): boolean {
  return envFlag(process.env.EMAIL_VERIFICATION_ENABLED);
}

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
    maxPasswordLength: 128,
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
    ...(emailVerificationEnabled() ? { sendOnSignUp: true } : {}),
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

  /**
   * Sessions. A session is refreshed at most once a day, so an active member
   * stays signed in for a week without a refresh write on every request.
   */
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  /**
   * Linking policy, stated explicitly for review.
   *
   * Only Google may be linked implicitly, and only when the existing local
   * account has a verified email (Better Auth's `requireLocalEmailVerified`
   * default). That is what stops somebody pre-registering an unverified
   * account at a victim's address and inheriting their Google identity.
   */
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  /**
   * Brute-force protection.
   *
   * Better Auth only applies its default limits in production, which would
   * leave a staging deploy open. These rules are explicit and tighter than
   * the default 100 requests per window on the endpoints worth attacking.
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/sign-in/social": { window: 60, max: 15 },
      "/request-password-reset": { window: 300, max: 5 },
      "/send-verification-email": { window: 300, max: 5 },
      "/reset-password": { window: 300, max: 10 },
      "/change-password": { window: 300, max: 10 },
      "/delete-user": { window: 300, max: 5 },
    },
  },

  advanced: {
    // Cookies must never travel over plain HTTP in production. Derived from the
    // configured base URL rather than NODE_ENV, which a container may not set.
    useSecureCookies: (process.env.BETTER_AUTH_URL || "").startsWith("https://"),
    ipAddress: {
      // The API runs behind Traefik, which appends the client address to
      // X-Forwarded-For. Without this every request would key on the proxy IP
      // and one abuser would throttle everybody.
      ipAddressHeaders: ["x-forwarded-for"],
    },
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

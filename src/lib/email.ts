import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Transactional email service for Better Auth (password reset and email
 * verification).
 *
 * Configuration is read from the environment only. Nothing in this file
 * holds a credential, and no message body, reset token or SMTP credential is
 * ever written to a log.
 *
 *   SMTP_HOST      e.g. smtp.titan.email
 *   SMTP_PORT      465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_SECURE    "true" for 465, "false" for 587
 *   SMTP_USER      mailbox user
 *   SMTP_PASS      password (never committed, never printed)
 *   EMAIL_FROM     e.g. TrueDiet <noreply@true-diet.com>
 *
 *   EMAIL_TRANSPORT=json   test mode: nodemailer jsonTransport, no network is
 *                          opened, no email leaves the machine. Used by tests.
 */

export interface AuthEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface AuthEmailResult {
  ok: boolean;
  /** Safe to log: a nodemailer message id, never a token or credential. */
  messageId?: string;
  /** Safe to log: a short reason, never the SMTP response body. */
  error?: string;
}

/** True only when every credential required to actually send is present. */
export function isEmailConfigured(): boolean {
  if (isTestTransport()) return true;
  return Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  );
}

export function isTestTransport(): boolean {
  return process.env.EMAIL_TRANSPORT === "json";
}

/** The mailbox that mail is sent from. Falls back to the SMTP username. */
export function getFromAddress(): string {
  const configured = process.env.EMAIL_FROM;
  if (configured && configured.trim()) return configured.trim();

  const user = (process.env.SMTP_USER || "").trim();
  if (!user) return "TrueDiet <noreply@true-diet.com>";
  // A mailbox can be used as the sender with a display name attached. A value
  // that is not an address is returned untouched so the failure is visible at
  // send time rather than silently rewriting it.
  return user.includes("@") ? `TrueDiet <${user}>` : user;
}

/** Non-secret connection summary - safe to log. Never includes SMTP_PASS. */
export function describeTransport(): {
  mode: string;
  host?: string;
  port?: number;
  secure?: boolean;
  from: string;
} {
  if (isTestTransport()) {
    return { mode: "json (no email is sent)", from: getFromAddress() };
  }
  return {
    mode: "smtp",
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? "true").toLowerCase() === "true",
    from: getFromAddress(),
  };
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (isTestTransport()) {
    // jsonTransport renders the message and returns it without opening any
    // socket, so tests never contact a real mailbox.
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }

  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? String(process.env.SMTP_SECURE).toLowerCase() === "true"
      : port === 465;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter;
}

/**
 * Reduces an error to something safe to log.
 *
 * nodemailer errors can embed the SMTP transcript, which for AUTH may contain
 * the credentials, so only the code/responseCode and error name are kept.
 */
function safeReason(err: unknown): string {
  const e = err as {
    code?: string;
    responseCode?: number;
    name?: string;
    message?: string;
  };
  const parts: string[] = [];
  if (e?.code) parts.push(String(e.code));
  if (e?.responseCode) parts.push(`smtp ${e.responseCode}`);
  if (parts.length) return parts.join(" ");
  if (e?.name && e.name !== "Error") return e.name;
  return "email transport failed";
}

/**
 * Sends one transactional message.
 *
 * Never throws: a failure is returned so the caller can decide what the user
 * is told, and so a broken SMTP server cannot fail an auth request.
 */
export async function sendAuthEmail(input: AuthEmailInput): Promise<AuthEmailResult> {
  if (!isEmailConfigured()) {
    return { ok: false, error: "email_not_configured" };
  }

  try {
    const info = await getTransporter().sendMail({
      from: getFromAddress(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      // Auth mail only - never list or bulk.
      headers: { "X-Auto-Response-Suppress": "All" },
    });
    return { ok: true, messageId: info.messageId ?? undefined };
  } catch (err) {
    return { ok: false, error: safeReason(err) };
  }
}

/** Test hook - lets a test suite build a fresh transport without reusing one. */
export function resetTransportCache(): void {
  transporter = null;
}

/**
 * Confirms the SMTP server answers the handshake.
 *
 * This does not send a message, so it is safe to run against the production
 * mailbox when the operator asks for it.
 */
export async function verifyConnection(): Promise<{ ok: boolean; error?: string }> {
  if (isTestTransport()) return { ok: true };
  if (!isEmailConfigured()) return { ok: false, error: "email_not_configured" };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: safeReason(err) };
  }
}


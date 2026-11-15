import { Hono } from "hono";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import {
  isEmailConfigured,
  describeTransport,
  verifyConnection,
} from "../lib/email.js";

/**
 * Staff-only operational diagnostics.
 *
 * Everything here is read-only and returns connection metadata only - never a
 * credential, a token or a message body. Access requires the same staff key
 * used by the push diagnostics (DIETITIAN_API_KEY, x-dietitian-key header).
 */
export const diagnosticsRoutes = new Hono();

function expectedStaffKey(): string {
  return (process.env.DIETITIAN_API_KEY || "").trim();
}

function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

diagnosticsRoutes.use("*", async (c, next) => {
  const provided = c.req.raw.headers.get("x-dietitian-key");
  const expected = expectedStaffKey();
  if (!expected) {
    return c.json(
      { error: "dietitian_key_not_configured", message: "DIETITIAN_API_KEY is not set on this server." },
      503
    );
  }
  if (provided === null || !keysMatch(provided, expected)) {
    return c.json({ error: "unauthorized", message: "Invalid dietitian key." }, 401);
  }
  await next();
});

/** Raw TCP reachability, so a blocked port is distinguishable from a bad login. */
function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false, "ETIMEDOUT"));
    socket.on("error", (e: NodeJS.ErrnoException) => finish(false, e.code || e.message));
  });
}

/** Implicit-TLS handshake, to confirm 465-style transport works from the host. */
function tlsProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const socket = tls.connect({ host, port, servername: host });
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.on("secureConnect", () => finish(true));
    socket.on("timeout", () => finish(false, "ETIMEDOUT"));
    socket.on("error", (e: NodeJS.ErrnoException) => finish(false, e.code || e.message));
  });
}

diagnosticsRoutes.get("/email", async (c) => {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE ?? "true").toLowerCase() === "true";

  const configured = isEmailConfigured();
  const transport = describeTransport();

  const result: Record<string, unknown> = {
    configured,
    transport,
    emailVerificationEnabled: (process.env.EMAIL_VERIFICATION_ENABLED || "").trim().toLowerCase(),
  };

  if (configured && host) {
    result.tcp = await tcpProbe(host, port);
    if (secure) result.tls = await tlsProbe(host, port);
    result.verify = await verifyConnection();
  }

  return c.json(result);
});

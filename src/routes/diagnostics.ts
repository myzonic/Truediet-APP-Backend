import { Hono } from "hono";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import nodemailer from "nodemailer";
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

/** STARTTLS submission probe: connect, upgrade, AUTH - no message is sent. */
async function starttlsProbe(host: string, port: number): Promise<{ ok: boolean; error?: string }> {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return { ok: false, error: "email_not_configured" };
  try {
    const t = nodemailer.createTransport({
      host,
      port,
      secure: false,
      requireTLS: true,
      auth: { user, pass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
    });
    await t.verify();
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; name?: string };
    return {
      ok: false,
      error: e?.code || (e?.responseCode ? `smtp ${e.responseCode}` : e?.name || "failed"),
    };
  }
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

    // Probe the standard submission ports so a host firewall that blocks a
    // single port (e.g. Hetzner blocks outbound 25 and 465 but not 587) is
    // distinguishable from a bad credential or a dead mail server.
    const ports = [25, 465, 587];
    result.ports = Object.fromEntries(
      await Promise.all(
        ports.map(async (p) => [
          String(p),
          p === port ? result.tcp : await tcpProbe(host, p, 6000),
        ])
      )
    );

    // A STARTTLS handshake on 587 proves the fallback transport works end to
    // end (connect + TLS upgrade + AUTH), without sending a message.
    result.starttls587 = await starttlsProbe(host, 587);
  }

  // Characterise the block: compare a plain HTTPS host, DNS, the IMAP ports of
  // the same mail host, and the alternate submission port 2525. This tells us
  // whether the firewall drops every non-443 port, only SMTP ports, or only
  // this mail host.
  result.egress = Object.fromEntries(
    await Promise.all(
      (
        [
          ["1.1.1.1", 443],
          ["8.8.8.8", 53],
          ["smtp.titan.email", 143],
          ["smtp.titan.email", 993],
          ["smtp.titan.email", 2525],
          ["smtp.titan.email", 25],
          ["smtp.titan.email", 587],
        ] as Array<[string, number]>
      ).map(async ([h, p]) => [`${h}:${p}`, await tcpProbe(h, p, 6000)])
    )
  );

  // Why can every port to the mail host time out while 443 and DNS work? The
  // usual cause is an AAAA (IPv6) record: the runtime prefers IPv6 and the
  // container has no working IPv6 route, so the connect hangs instead of
  // failing fast. Resolve the host and probe each family explicitly.
  const dnsReport: Record<string, unknown> = {};
  let v4: string[] = [];
  let v6: string[] = [];
  try {
    v4 = await dns.resolve4(host || "smtp.titan.email");
    dnsReport.a = v4;
  } catch (e) {
    dnsReport.a = (e as NodeJS.ErrnoException)?.code || "error";
  }
  try {
    v6 = await dns.resolve6(host || "smtp.titan.email");
    dnsReport.aaaa = v6;
  } catch (e) {
    dnsReport.aaaa = (e as NodeJS.ErrnoException)?.code || "error";
  }
  result.dns = dnsReport;

  // Probe each resolved address directly (bypassing the resolver's preference)
  // plus an unrelated MX host on port 25, to separate "SMTP ports are blocked"
  // from "this host is unreachable".
  const targets: Array<[string, number]> = [
    ...v4.map((ip) => [ip, 465] as [string, number]),
    ...v6.map((ip) => [ip, 465] as [string, number]),
    ["gmail-smtp-in.l.google.com", 25],
    ["aspmx.l.google.com", 25],
  ];
  result.targets = Object.fromEntries(
    await Promise.all(
      targets.map(async ([h, p]) => [`${h}:${p}`, await tcpProbe(h, p, 6000)])
    )
  );

  return c.json(result);
});

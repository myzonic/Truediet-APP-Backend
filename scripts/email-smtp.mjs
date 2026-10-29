/**
 * Operator tool for the auth email service.
 *
 * Never prints SMTP_PASS, a reset token or an email body.
 *
 *   node scripts/email-smtp.mjs                  # config report (no network)
 *   node scripts/email-smtp.mjs --verify         # SMTP handshake only, no message sent
 *   node scripts/email-smtp.mjs --send you@x.com # sends ONE message (explicit, operator only)
 *   node scripts/email-smtp.mjs --json           # renders a message, sends nothing
 *
 * Run it from the backend project directory (server/). Inside the deployed
 * container the credentials come from the environment instead of a file, so
 * both paths work and an existing environment always wins.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. The backend's own .env, next to package.json - resolved from this file so
//    the current working directory does not matter.
const envFile = path.resolve(here, "..", ".env");
const loaded = dotenv.config({ path: envFile });
if (loaded.error && loaded.error.code !== "ENOENT") {
  console.log(`warning: could not read ${envFile}`);
}
// 2. Anything already exported (Dokploy / CI) is never overridden, and a
//    different cwd .env may fill in values the first load did not set.
dotenv.config();

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_TRANSPORT,
} = process.env;

function mask(value) {
  if (!value) return "(unset)";
  return `[${String(value).length} characters]`;
}

async function main() {
  const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
  const jsonMode = EMAIL_TRANSPORT === "json";

  console.log("\nAuth email configuration (values never printed):");
  console.log(`  mode          : ${jsonMode ? "json (test, nothing is sent)" : configured ? "smtp" : "NOT CONFIGURED"}`);
  console.log(`  SMTP_HOST     : ${SMTP_HOST || "(unset)"}`);
  console.log(`  SMTP_PORT     : ${SMTP_PORT || "(unset) -> default 465"}`);
  console.log(`  SMTP_SECURE   : ${SMTP_SECURE || "(unset) -> default true for 465"}`);
  console.log(`  SMTP_USER     : ${SMTP_USER || "(unset)"}`);
  console.log(`  SMTP_PASS     : ${mask(SMTP_PASS)}`);
  console.log(`  EMAIL_FROM    : ${EMAIL_FROM || "(unset, falls back to the SMTP user)"}`);

  if (has("--json")) {
    const { sendAuthEmail, resetTransportCache } = await import("../dist/lib/email.js").catch(
      () => ({ sendAuthEmail: null, resetTransportCache: null })
    );
    if (!sendAuthEmail) {
      console.log("\nBuild first: npm run build (dist/lib/email.js missing)");
      process.exit(1);
    }
    process.env.EMAIL_TRANSPORT = "json";
    resetTransportCache();
    const { passwordResetEmail } = await import("../dist/lib/email-templates.js");
    const tpl = passwordResetEmail(
      "Test Recipient",
      `https://api.true-diet.com/reset?token=EXAMPLE_TOKEN_DO_NOT_USE`
    );
    const res = await sendAuthEmail({ to: "nobody@example.com", subject: tpl.subject, text: tpl.text, html: tpl.html });
    console.log(`\njson render: ok=${res.ok} messageId=${res.messageId || "(none)"}`);
    console.log("Rendered JSON (contains the message only, no credentials):");
    // jsonTransport returns info.message with the composed message.
    console.log(`  subject: ${tpl.subject}`);
    console.log(`  text bytes: ${tpl.text.length} | html bytes: ${tpl.html.length}`);
    process.exit(res.ok ? 0 : 1);
  }

  if (has("--verify")) {
    if (!configured) {
      console.log("\nCannot verify: SMTP_HOST, SMTP_USER and SMTP_PASS must all be set.");
      process.exit(1);
    }
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(SMTP_PORT || 465);
    const secure = SMTP_SECURE !== undefined ? SMTP_SECURE === "true" : port === 465;
    const t = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    try {
      await t.verify();
      console.log(`\nOK - ${SMTP_HOST}:${port} (secure=${secure}) accepted the connection and credentials.`);
      console.log("No message was sent.");
      process.exit(0);
    } catch (e) {
      // Only a short reason: nodemailer errors can embed the SMTP transcript.
      console.log(`\nFAILED - code=${e.code || "?"} responseCode=${e.responseCode || "?"} name=${e.name || "?"}`);
      console.log("No message was sent. Check host/port/secure/user/password.");
      process.exit(1);
    }
  }

  if (has("--send")) {
    const idx = args.indexOf("--send");
    const to = args[idx + 1];
    if (!to) {
      console.log("\nUsage: node scripts/email-smtp.mjs --send you@your-domain.com");
      process.exit(1);
    }
    if (!configured) {
      console.log("\nCannot send: SMTP_HOST, SMTP_USER and SMTP_PASS must all be set.");
      process.exit(1);
    }
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(SMTP_PORT || 465);
    const secure = SMTP_SECURE !== undefined ? SMTP_SECURE === "true" : port === 465;
    const t = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    try {
      const info = await t.sendMail({
        from: EMAIL_FROM || `TrueDiet <${SMTP_USER}>`,
        to,
        subject: "True Diet - SMTP delivery test",
        text:
          "This is a delivery test for the True Diet authentication mailbox.\n\n" +
          "If you received it, password reset and verification emails can be delivered.\n\n" +
          "No action is required - you can delete this message.\n",
        html:
          "<p>This is a <strong>delivery test</strong> for the True Diet authentication mailbox.</p>" +
          "<p>If you received it, password reset and verification emails can be delivered.</p>" +
          "<p>No action is required - you can delete this message.</p>",
      });
      console.log(`\nSENT to ${to}`);
      console.log(`  messageId: ${info.messageId || "(accepted by the server)"}`);
      process.exit(0);
    } catch (e) {
      console.log(`\nFAILED - code=${e.code || "?"} responseCode=${e.responseCode || "?"} name=${e.name || "?"}`);
      process.exit(1);
    }
  }

  // Default: report only.
  if (!configured && !jsonMode) {
    console.log("\nNot configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in server/.env or in Dokploy.");
    process.exit(1);
  }
  if (jsonMode) {
    console.log("\nEMAIL_TRANSPORT=json is set - no real email will be sent in this process.");
    console.log("Unset it (or use a shell without it) before running --verify or --send.");
    process.exit(0);
  }
  console.log("\nNext steps:");
  console.log("  node scripts/email-smtp.mjs --verify");
  console.log("  node scripts/email-smtp.mjs --json            # render only, sends nothing");
  console.log("  node scripts/email-smtp.mjs --send you@domain # sends exactly one message");
}

main().catch((e) => {
  console.log("\nFAILED - unexpected error: " + (e && e.message));
  process.exit(1);
});

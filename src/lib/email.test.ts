import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeTransport,
  isEmailConfigured,
  isTestTransport,
  resetTransportCache,
  sendAuthEmail,
  verifyConnection,
} from "./email.js";
import { emailVerificationEmail, passwordResetEmail } from "./email-templates.js";

const LINK = "https://api.true-diet.com/reset?token=abcDEF1234567890";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTransportCache();
  try {
    fn();
  } finally {
    for (const key of Object.keys(original)) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTransportCache();
  }
}

test("password reset template carries the link, the expiry and the single-use warning", () => {
  const t = passwordResetEmail("Sam", LINK, 60);
  assert.equal(t.subject, "Reset your True Diet password");
  assert.ok(t.text.includes(LINK), "text contains the link");
  assert.ok(/60 minutes/.test(t.text), "text states the expiry");
  assert.ok(/only once/.test(t.text), "text warns the link is single use");
  assert.ok(/ignore this email/i.test(t.text), "text covers an unrequested reset");
  assert.ok(t.html.includes(LINK), "html contains the link");
  assert.ok(t.html.includes('href="' + LINK + '"'), "html makes the link a real anchor");
  assert.ok(/only once/.test(t.html), "html states single use");
});

test("email verification template carries the link and the expiry", () => {
  const t = emailVerificationEmail("Sam", "https://api.true-diet.com/verify-email?token=t0k", 60);
  assert.equal(t.subject, "Verify your email for True Diet");
  assert.ok(t.text.includes("verify-email?token=t0k"), "text contains the link");
  assert.ok(/60 minutes/.test(t.text), "text states the expiry");
  assert.ok(t.html.includes("verify-email?token=t0k"), "html contains the link");
});

test("templates escape a hostile display name", () => {
  const hostile = '<script>alert(1)</script>';
  const t = passwordResetEmail(hostile, LINK, 60);
  assert.ok(!t.html.includes("<script>alert(1)</script>"), "raw script tag is not emitted");
  assert.ok(t.html.includes("&lt;script&gt;"), "the name is escaped");
  // Plain text keeps it literal, which is safe - it is never executed there.
  assert.ok(t.text.includes(hostile), "text keeps the name as text");
});

test("isEmailConfigured is false without a password", () => {
  withEnv({ SMTP_HOST: "smtp.titan.email", SMTP_USER: "noreply@true-diet.com", SMTP_PASS: "" }, () => {
    assert.equal(isEmailConfigured(), false);
  });
  withEnv({ SMTP_HOST: "", SMTP_USER: "noreply@true-diet.com", SMTP_PASS: "x" }, () => {
    assert.equal(isEmailConfigured(), false);
  });
});

test("isEmailConfigured is true with full SMTP credentials", () => {
  withEnv(
    { SMTP_HOST: "smtp.titan.email", SMTP_USER: "noreply@true-diet.com", SMTP_PASS: "pw" },
    () => {
      assert.equal(isEmailConfigured(), true);
      assert.equal(isTestTransport(), false);
    }
  );
});

test("json test transport counts as configured", () => {
  withEnv({ EMAIL_TRANSPORT: "json", SMTP_PASS: "" }, () => {
    assert.equal(isTestTransport(), true);
    assert.equal(isEmailConfigured(), true);
  });
});

test("json transport reports success without opening a socket", async () => {
  withEnv({ EMAIL_TRANSPORT: "json" }, async () => {
    const t = passwordResetEmail("Sam", LINK, 60);
    const res = await sendAuthEmail({ to: "someone@example.com", ...t });
    assert.equal(res.ok, true, "json transport succeeds: " + (res.error || ""));
    assert.ok(res.messageId, "a message id is returned");
  });
  await Promise.resolve();
});

test("unconfigured email is reported instead of pretending to send", async () => {
  withEnv({ SMTP_PASS: "", SMTP_HOST: "", SMTP_USER: "" }, async () => {
    const res = await sendAuthEmail({ to: "someone@example.com", ...passwordResetEmail("Sam", LINK) });
    assert.equal(res.ok, false);
    assert.equal(res.error, "email_not_configured");
  });
  await Promise.resolve();
});

test("an SMTP failure never reports the credential", async () => {
  const canary = "CANARY-DO-NOT-LEAK-98765";
  // Port 1 is always closed, so the connection fails immediately and no mail
  // is ever composed for delivery. There is nothing to leak to a mailbox.
  await withEnvAsync(
    {
      EMAIL_TRANSPORT: undefined,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1",
      SMTP_SECURE: "false",
      SMTP_USER: "noreply@true-diet.com",
      SMTP_PASS: canary,
    },
    async () => {
      const res = await sendAuthEmail({ to: "someone@example.com", ...passwordResetEmail("Sam", LINK) });
      assert.equal(res.ok, false, "connection failure is reported");
      assert.ok(res.error, "a reason is returned");
      assert.ok(!res.error.includes(canary), "the password is not in the reason");
      assert.ok(!res.error.includes(LINK), "the reset link is not in the reason");
      // nodemailer may put the host in `message`; the reason must stay code-only.
      assert.ok(!/AUTH|password|smtp\.dyndns/i.test(res.error), "no SMTP dialogue in the reason");
    }
  );
});

test("describeTransport never includes the password", async () => {
  const canary = "CANARY-NO-TRANSPORT-LEAK";
  await withEnvAsync(
    { SMTP_HOST: "smtp.titan.email", SMTP_PORT: "465", SMTP_PASS: canary },
    async () => {
      const info = describeTransport();
      assert.equal(info.mode, "smtp");
      assert.equal(info.host, "smtp.titan.email");
      assert.equal(info.port, 465);
      assert.equal(info.secure, true);
      const rendered = JSON.stringify(info);
      assert.ok(!rendered.includes(canary), "password never reaches a log line");
      assert.ok(!rendered.includes("SMTP_PASS"), "no credential key in a log line");
    }
  );
});

test("verifyConnection short-circuits on the json transport", async () => {
  await withEnvAsync({ EMAIL_TRANSPORT: "json" }, async () => {
    const res = await verifyConnection();
    assert.equal(res.ok, true);
  });
});

test("default from address falls back to the SMTP user", async () => {
  await withEnvAsync({ EMAIL_FROM: "", SMTP_USER: "noreply@true-diet.com" }, async () => {
    const { getFromAddress } = await import("./email.js");
    assert.equal(getFromAddress(), "TrueDiet <noreply@true-diet.com>");
  });
  await withEnvAsync({ EMAIL_FROM: "", SMTP_USER: "" }, async () => {
    const { getFromAddress } = await import("./email.js");
    assert.equal(getFromAddress(), "TrueDiet <noreply@true-diet.com>");
  });
  await withEnvAsync({ EMAIL_FROM: "TrueDiet <noreply@true-diet.com>" }, async () => {
    const { getFromAddress } = await import("./email.js");
    assert.equal(getFromAddress(), "TrueDiet <noreply@true-diet.com>");
  });
  // A non-address user name is passed through untouched rather than rewritten
  // into an invalid sender.
  await withEnvAsync({ EMAIL_FROM: "", SMTP_USER: "not-an-address" }, async () => {
    const { getFromAddress } = await import("./email.js");
    assert.equal(getFromAddress(), "not-an-address");
  });
});

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTransportCache();
  try {
    await fn();
  } finally {
    for (const key of Object.keys(original)) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTransportCache();
  }
}

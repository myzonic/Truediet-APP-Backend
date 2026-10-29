/**
 * Auth email templates for True Diet.
 *
 * Plain text plus a small inline-styled HTML alternative. No external assets,
 * no trackers, no marketing content - these are transactional messages.
 */

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHELL_CSS = [
  "body{margin:0;background:#F4F8F7;font-family:Helvetica,Arial,sans-serif;color:#1B2A2A}",
  ".card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #DCE7E4;border-radius:16px;padding:32px 28px}",
  ".brand{font-size:13px;letter-spacing:2px;font-weight:700;color:#0B6B5B;text-transform:uppercase;margin:0 0 20px}",
  "h1{font-size:22px;line-height:1.3;margin:0 0 14px;color:#0B3B36}",
  "p{font-size:15px;line-height:1.6;margin:0 0 14px;color:#33413F}",
  ".btn{display:block;text-align:center;background:#0B3B36;color:#fff;text-decoration:none;",
  "border-radius:12px;padding:16px 22px;font-size:16px;font-weight:700;margin:22px 0 6px}",
  ".alt{font-size:12px;line-height:1.5;color:#6B7C7A;word-break:break-all}",
  ".note{font-size:12px;line-height:1.6;color:#6B7C7A;border-top:1px solid #E7EEEC;padding-top:16px;margin-top:8px}",
].join("");

function shell(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head><body>` +
    `<div class="card"><p class="brand">True Diet</p>${bodyHtml}</div>` +
    `</body></html>`
  );
}

export interface PasswordResetTemplate {
  subject: string;
  text: string;
  html: string;
}

/**
 * @param url the full link that opens the password reset form
 * @param expiresMinutes value better-auth will actually enforce
 */
export function passwordResetEmail(
  name: string,
  url: string,
  expiresMinutes = 60
): PasswordResetTemplate {
  const safeName = name || "there";
  const subject = "Reset your True Diet password";
  const text =
    `Hi ${safeName},\n\n` +
    `Someone asked to reset the password for your True Diet account.\n\n` +
    `Set a new password here (valid for ${expiresMinutes} minutes):\n${url}\n\n` +
    `If you did not request this, you can safely ignore this email - your password stays unchanged.\n\n` +
    `This link can be used only once. If it has already been used, or if it expires, request a new link from the app.\n\n` +
    `True Diet\n` +
    `Registered Dietitian nutrition education\n`;

  const html = shell(
    subject,
    `<h1>Hi ${escapeHtml(safeName)},</h1>` +
      `<p>Someone asked to reset the password for your True Diet account.</p>` +
      `<a class="btn" href="${escapeHtml(url)}">Set a new password</a>` +
      `<p class="alt">This link is valid for ${expiresMinutes} minutes and can be used only once.</p>` +
      `<p class="alt">${escapeHtml(url)}</p>` +
      `<p class="note">If you did not request this, you can safely ignore this email - ` +
      `your password stays unchanged. If it has already been used, or if it expires, ` +
      `request a new link from the app.</p>`
  );

  return { subject, text, html };
}

export interface EmailVerificationTemplate {
  subject: string;
  text: string;
  html: string;
}

export function emailVerificationEmail(
  name: string,
  url: string,
  expiresMinutes = 60
): EmailVerificationTemplate {
  const safeName = name || "there";
  const subject = "Verify your email for True Diet";
  const text =
    `Hi ${safeName},\n\n` +
    `Confirm this address to finish setting up your True Diet account:\n${url}\n\n` +
    `This link is valid for ${expiresMinutes} minutes.\n\n` +
    `If you did not create this account, you can ignore this email.\n\n` +
    `True Diet\n`;

  const html = shell(
    subject,
    `<h1>Confirm your email</h1>` +
      `<p>Hi ${escapeHtml(safeName)}, confirm this address to finish setting up your True Diet account.</p>` +
      `<a class="btn" href="${escapeHtml(url)}">Verify my email</a>` +
      `<p class="alt">Valid for ${expiresMinutes} minutes.</p>` +
      `<p class="alt">${escapeHtml(url)}</p>` +
      `<p class="note">If you did not create this account, you can ignore this email.</p>`
  );

  return { subject, text, html };
}

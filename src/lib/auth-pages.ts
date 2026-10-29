/**
 * HTML pages that back the auth links Better Auth emails out.
 *
 * The app is React Native/Expo Go, which cannot open a custom-scheme link
 * from an email and has no web frontend, so the emailed link points at a page
 * this server renders at https://api.true-diet.com/reset. Same origin as the
 * API, so the form posts with no CORS or redirect configuration.
 *
 * No external assets, no trackers, no secrets in markup.
 */

const RESET_CSS = [
  "body{margin:0;background:#F4F8F7;font-family:Helvetica,Arial,sans-serif;color:#1B2A2A}",
  ".wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}",
  ".card{width:100%;max-width:440px;background:#fff;border:1px solid #DCE7E4;border-radius:18px;padding:32px 28px}",
  ".brand{font-size:12px;letter-spacing:2px;font-weight:700;color:#0B6B5B;text-transform:uppercase;margin:0 0 18px}",
  "h1{font-size:23px;line-height:1.3;margin:0 0 10px;color:#0B3B36}",
  "p{font-size:15px;line-height:1.6;margin:0 0 18px;color:#33413F}",
  "label{display:block;font-size:13px;font-weight:700;color:#0B3B36;margin:0 0 8px}",
  "input{width:100%;box-sizing:border-box;font-size:16px;padding:15px 14px;border:1px solid #C9D7D4;",
  "border-radius:12px;background:#fff;color:#1B2A2A}",
  "input:focus{outline:none;border-color:#0B6B5B}",
  "button{width:100%;margin-top:22px;padding:16px;border:0;border-radius:12px;background:#0B3B36;",
  "color:#fff;font-size:16px;font-weight:700;cursor:pointer}",
  "button:disabled{opacity:.5;cursor:not-allowed}",
  ".msg{margin-top:16px;padding:14px;border-radius:12px;font-size:14px;line-height:1.5;display:none}",
  ".err{background:#FDECEC;border:1px solid #F2C4C4;color:#8E1B1B;display:block}",
  ".ok{background:#E7F6EE;border:1px solid #BFE6CE;color:#136C43;display:block}",
  ".hint{font-size:12px;color:#6B7C7A;line-height:1.6;margin-top:20px;border-top:1px solid #E7EEEC;padding-top:16px}",
  ".link{color:#0B6B5B}",
].join("");

const SECURE_JS = [
  "var form=document.getElementById('f');",
  "var btn=document.getElementById('b');",
  "var pw=document.getElementById('p');",
  "var pw2=document.getElementById('p2');",
  "var err=document.getElementById('e');",
  "var ok=document.getElementById('o');",
  "var token=document.getElementById('tk').value;",
  "function show(el,txt){el.textContent=txt;el.style.display='block';}",
  "form.addEventListener('submit',function(ev){",
  "ev.preventDefault();",
  "err.style.display='none';ok.style.display='none';",
  "if(pw.value.length<8){show(err,'Password must be at least 8 characters.');pw.focus();return;}",
  "if(pw.value!==pw2.value){show(err,'Both passwords must match.');pw2.focus();return;}",
  "btn.disabled=true;btn.textContent='Updating password…';",
  "fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},",
  "body:JSON.stringify({newPassword:pw.value,token:token})})",
  ".then(function(r){return r.text().then(function(t){return {status:r.status,body:t};});})",
  ".then(function(res){",
  "var data={};try{data=JSON.parse(res.body);}catch(e){}",
  "if(res.status>=200&&res.status<300&&data.status){",
  "form.style.display='none';",
  "show(ok,'Password updated. Open the True Diet app and sign in with your new password.');",
  "return;}",
  "var code=data.code||'';",
  "if(code==='TOKEN_EXPIRED'||code==='INVALID_TOKEN'||res.status===400){",
  "show(err,'This link is invalid or has expired. Request a new reset link from the app.');",
  "btn.disabled=false;btn.textContent='Set a new password';return;}",
  "if(data.message){show(err,data.message);}else{show(err,'Could not update the password. Please try again.');}",
  "btn.disabled=false;btn.textContent='Set a new password';",
  "})",
  ".catch(function(){show(err,'Network error. Check your connection and try again.');",
  "btn.disabled=false;btn.textContent='Set a new password';});",
  "});",
].join("");

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEAD =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex,nofollow">';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface Page {
  html: string;
  contentType: string;
  status: number;
}

/** Shared security headers for every page rendered by this module. */
export function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * GET /reset?token=... - the password reset form.
 *
 * Tokens arrive in the query string, so the value is only ever echoed back
 * into an attribute that is HTML-escaped, and the token itself is Better Auth's
 * random 24-character id (single use, one hour).
 */
export function renderResetPage(params: URLSearchParams): Page {
  const token = (params.get("token") || "").trim();
  const errorParam = (params.get("error") || "").trim();
  const emailParam = (params.get("email") || "").trim();

  const hasToken = token.length > 0;
  // `email` is optional (only present if a caller sends it) and escaped.
  const who = emailParam ? ` for <strong>${escapeHtml(emailParam)}</strong>` : "";

  let prefillError = "";
  if (!hasToken) {
    prefillError = "This link is incomplete. Request a new reset link from the app.";
  } else if (errorParam === "TOKEN_EXPIRED") {
    prefillError = "This link has expired. Request a new reset link from the app.";
  } else if (errorParam) {
    prefillError = "This link is not valid. Request a new reset link from the app.";
  }

  const body = prefillError
    ? `<div class="msg err" role="alert">${escapeHtml(prefillError)}</div>
       <p class="hint">Reset links are valid for one hour and can be used once.</p>`
    : `<form id="f" novalidate>
         <label for="p">New password</label>
         <input id="p" name="password" type="password" autocomplete="new-password"
                minlength="8" required placeholder="At least 8 characters">
         <label for="p2" style="margin-top:16px">Confirm new password</label>
         <input id="p2" name="confirm" type="password" autocomplete="new-password"
                minlength="8" required placeholder="Repeat the new password">
         <input id="tk" type="hidden" value="${escapeHtml(token)}">
         <div class="msg err" id="e" role="alert"></div>
         <div class="msg ok" id="o" role="status"></div>
         <button id="b" type="submit">Set a new password</button>
       </form>
       <p class="hint">This link works once and expires one hour after it was sent${who}.<br>
       Changed your mind? Close this page - your current password still works.</p>`;

  const html =
    `${HEAD}<title>Set a new password · True Diet</title></head><body>` +
    `<div class="wrap"><div class="card">` +
    `<p class="brand">True Diet</p>` +
    `<h1>Set a new password</h1>` +
    `<p>Choose a password of at least 8 characters. Your previous password stops working.</p>` +
    body +
    `</div></div>` +
    `<script>${SECURE_JS}</script></body></html>`;

  return { html, contentType: "text/html; charset=utf-8", status: 200 };
}

/**
 * GET /verify-email?token=... - the email verification result.
 *
 * Calls Better Auth's own endpoint without a callbackURL so the response is
 * JSON rather than a redirect, then reports the outcome.
 */
export function renderVerifyPage(): Page {
  const html =
    `${HEAD}<title>Verify your email · True Diet</title></head><body>` +
    `<div class="wrap"><div class="card">` +
    `<p class="brand">True Diet</p>` +
    `<h1>Verifying your email</h1>` +
    `<p id="s">Checking your link…</p>` +
    `<div class="msg err" id="e" role="alert"></div>` +
    `<div class="msg ok" id="o" role="status"></div>` +
    `<p class="hint">Email verification is optional in True Diet. ` +
    `You can always sign in without verifying this address.</p>` +
    `</div></div>` +
    `<script>` +
    `(function(){` +
    `var params=new URLSearchParams(window.location.search);` +
    `var token=params.get('token')||'';` +
    `var out=document.getElementById('s');` +
    `var err=document.getElementById('e');` +
    `var ok=document.getElementById('o');` +
    `var known={TOKEN_EXPIRED:'This verification link has expired. Request a new one from the app.',` +
    `INVALID_TOKEN:'This verification link is not valid. Request a new one from the app.',` +
    `USER_NOT_FOUND:'This account no longer exists.'};` +
    `function fail(t){out.style.display='none';err.textContent=t;err.style.display='block';}` +
    `function done(){out.style.display='none';ok.textContent='Email verified.';ok.style.display='block';}` +
    `if(!token){fail('This link is incomplete. Request a new verification link from the app.');return;}` +
    `fetch('/api/auth/verify-email?token='+encodeURIComponent(token))` +
    `.then(function(r){return r.text().then(function(t){return {status:r.status,body:t};});})` +
    `.then(function(res){var d={};try{d=JSON.parse(res.body);}catch(e){}` +
    `if(res.status>=200&&res.status<300&&d.status){done();return;}` +
    `var code=(d.code||'').toUpperCase();` +
    `fail(known[code]||d.message||'Could not verify this email. Please try again.');})` +
    `.catch(function(){fail('Network error. Check your connection and try again.');});` +
    `})();` +
    `</script></body></html>`;

  return { html, contentType: "text/html; charset=utf-8", status: 200 };
}

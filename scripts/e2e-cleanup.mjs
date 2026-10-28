/**
 * Signs in as known throwaway E2E accounts and deletes them, so a failed
 * verification run cannot leave test rows in the production database.
 *
 *   node scripts/e2e-cleanup.mjs [baseUrl] [tag]
 */
const BASE = process.argv[2] || "https://api.true-diet.com";
const TAG = process.argv[3] || "e2e-1793158425776";
const password = "ProdE2ePass123!";

const candidates = [`${TAG}@truediet.test`, `${TAG}-other@truediet.test`];

async function api(path, { method = "GET", body, cookie = "" } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8081",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const sc = res.headers.get("set-cookie");
  const setCookie = sc ? sc.split(";")[0] : "";
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, setCookie };
}

console.log(`\nE2E leftover cleanup: ${BASE}  (tag: ${TAG})\n`);

let removed = 0;
for (const email of candidates) {
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });

  if (signin.status !== 200) {
    const code = signin.data?.code || signin.data?.message || signin.status;
    console.log(`  SKIP  ${email} - not signable (${code}) -> already removed or never created`);
    continue;
  }

  const del = await api("/api/account", {
    method: "DELETE",
    cookie: signin.setCookie,
  });

  if (del.status === 200) {
    const verify = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    if (verify.status !== 200) {
      console.log(`  PASS  ${email} - account deleted`);
      removed++;
    } else {
      console.log(`  FAIL  ${email} - still signable after DELETE`);
    }
  } else {
    console.log(`  FAIL  ${email} - DELETE returned ${del.status}`);
  }
}

console.log(`\n${removed} test account(s) removed`);
process.exit(0);

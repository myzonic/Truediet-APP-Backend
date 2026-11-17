/**
 * E2E proof for the CURRENT custom-auth API against the live backend.
 * Connects via a fixed IP (bypasses stale local DNS) with TLS SNI = api.true-diet.com.
 * Creates a throwaway account, exercises flows, then deletes it.
 *
 *   node scripts/e2e-custom-auth.mjs
 */
import https from 'node:https';
import tls from 'node:tls';

const HOST = 'api.true-diet.com';
const IP = '152.53.227.233';
let token = '';
let sessionToken = '';
let results = [];

function req(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', Host: HOST };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (auth && token) headers['Authorization'] = `Bearer ${token}`;
    const options = {
      host: IP,
      port: 443,
      method,
      path,
      headers,
      // TLS SNI + cert verification use the real hostname, not the IP.
      servername: HOST,
      checkServerIdentity: (name, cert) => tls.checkServerIdentity(HOST, cert),
      rejectUnauthorized: true,
    };
    const r = https.request(options, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  PASS  ${n}${d ? ' - ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  FAIL  ${n}${d ? ' - ' + d : ''}`); };

const stamp = Date.now();
const email = `e2e.${stamp}@gmail.com`;
const password = 'FlowTest123!';
console.log(`\nE2E custom auth @ https://${HOST} (via ${IP})`);
console.log(`throwaway account: ${email}\n`);

// health
{
  const { status, data } = await req('GET', '/health', undefined, false);
  if (status === 200 && data?.database === 'connected' && data?.schema === 'complete')
    pass('health: DB connected + schema complete');
  else fail('health', `status ${status} ${JSON.stringify(data).slice(0, 150)}`);
}

// register
let userId = '';
{
  const { status, data } = await req('POST', '/api/auth/register', { name: 'Flow Test', email, password }, false);
  userId = data?.user?.id || '';
  token = data?.token || '';
  sessionToken = data?.session?.token || '';
  if ((status === 200 || status === 201) && userId && token)
    pass('register: user + JWT issued', `verificationEmailSent=${data.verificationEmailSent}`);
  else fail('register', `status ${status} ${JSON.stringify(data).slice(0, 150)}`);
}

// session (bearer works)
{
  const { status, data } = await req('GET', '/api/auth/session');
  if (status === 200 && data?.user?.id === userId) pass('session: bearer JWT authenticated');
  else fail('session', `status ${status} ${JSON.stringify(data).slice(0, 120)}`);
}

// profile save + read
{
  const post = await req('POST', '/api/profile', { goal: 'Build muscle', age: '34', dietaryPreferences: ['gluten free'] });
  const get = await req('GET', '/api/profile');
  const goal = get.data?.profile?.goal;
  if ((post.status === 200 || post.status === 201) && goal === 'Build muscle')
    pass('profile: saved and read back', `goal=${goal}`);
  else fail('profile', `post ${post.status} get ${get.status} goal=${goal}`);
}

// meal log create + read
{
  const post = await req('POST', '/api/meals', { mealType: 'breakfast', description: 'Oats and eggs', source: 'manual' });
  const get = await req('GET', '/api/meals');
  const meals = get.data?.meals || [];
  if ((post.status === 200 || post.status === 201) && meals.length >= 1)
    pass('meals: persisted and read back', `count=${meals.length}`);
  else fail('meals', `post ${post.status} get ${get.status} body=${JSON.stringify(get.data).slice(0,120)}`);
}

// water setting + summary (endpoint is POST /api/tracking-settings)
{
  const post = await req('POST', '/api/tracking-settings', { waterGoalMl: 2500 });
  const log = await req('POST', '/api/water', { amountMl: 500 });
  const get = await req('GET', '/api/water-summary');
  if ([200, 201].includes(post.status) && [200, 201].includes(log.status) && get.status === 200)
    pass('water: settings + log + summary OK', `goal=${get.data?.dailyGoalMl} total=${get.data?.totalMl}`);
  else fail('water', `post ${post.status} log ${log.status} get ${get.status}`);
}

// logout (session token)
{
  const { status, data } = await req('POST', '/api/auth/logout', { token: sessionToken }, false);
  if (status === 200 && data?.success) pass('logout: session revoked');
  else fail('logout', `status ${status} ${JSON.stringify(data).slice(0,120)}`);
}

// login after logout (wrong password -> 401, right password -> 200)
{
  const bad = await req('POST', '/api/auth/login', { email, password: 'wrongpass123' }, false);
  if (bad.status === 401) pass('login: wrong password rejected 401');
  else fail('login-wrong', `status ${bad.status}`);
  const good = await req('POST', '/api/auth/login', { email, password }, false);
  token = good.data?.token || '';
  sessionToken = good.data?.session?.token || '';
  if (good.status === 200 && token) pass('login: correct password -> user + JWT');
  else fail('login-good', `status ${good.status} ${JSON.stringify(good.data).slice(0,120)}`);
}

// email verification resend
{
  const r = await req('POST', '/api/auth/verify-email', { email }, false);
  if ([200, 201].includes(r.status) || r.data?.alreadyVerified) pass('verify-email: resend accepted', `status ${r.status}`);
  else fail('verify-email', `status ${r.status} ${JSON.stringify(r.data).slice(0,120)}`);
}

// cleanup: delete throwaway account
{
  const r = await req('DELETE', '/api/account');
  if (r.status === 200 && r.data?.deleted) pass('cleanup: throwaway account deleted');
  else fail('cleanup', `status ${r.status} ${JSON.stringify(r.data).slice(0,120)}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nRESULT: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);

import { Hono } from 'hono';
import { auth } from '../lib/auth.js';
import {
  getDietitianUserId,
  getStreamApiKey,
  getStreamAppId,
  getStreamClient,
  isStreamConfigured,
} from '../lib/stream.js';

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
};

export const streamRoutes = new Hono<{ Variables: Variables }>();

// GET /api/stream/config - public status check (no secrets returned)
streamRoutes.get('/config', (c) => {
  return c.json({
    configured: isStreamConfigured(),
    apiKey: getStreamApiKey(),
    appId: getStreamAppId(),
  });
});

// Everything below requires an authenticated session.
streamRoutes.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }
  c.set('user', session.user);
  await next();
});

// POST /api/stream/token - mint a user token for the signed-in member
streamRoutes.post('/token', async (c) => {
  const user = c.get('user') as { id: string; name: string };
  const client = getStreamClient();
  if (!client || !isStreamConfigured()) {
    return c.json({ error: 'not_configured', message: 'Stream is not configured' }, 503);
  }
  const streamUserId = user.id;
  try {
    await client.upsertUsers([{ id: streamUserId, name: user.name || streamUserId }]);
    const token = client.generateUserToken({ user_id: streamUserId });
    return c.json({ token, userId: streamUserId, apiKey: getStreamApiKey() });
  } catch (e: any) {
    return c.json({ error: 'stream_error', message: e?.message || 'Failed to generate token' }, 500);
  }
});

// POST /api/stream/call - create or re-join the call for an appointment
streamRoutes.post('/call', async (c) => {
  const user = c.get('user') as { id: string; name: string; email: string };
  const client = getStreamClient();
  if (!client || !isStreamConfigured()) {
    return c.json({ error: 'not_configured', message: 'Stream is not configured' }, 503);
  }

  const payload = await c.req.json().catch(() => ({}));
  const callType = payload?.callType || 'default';
  const callMode = payload?.callMode === 'phone' ? 'phone' : 'video';
  const callId =
    payload?.callId ||
    `visit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dietitianUserId = getDietitianUserId();

  try {
    await client.upsertUsers([
      { id: user.id, name: user.name || user.email },
      { id: dietitianUserId, name: 'Maureen Ashbarry, MS, RD' },
    ]);

    const call = client.video.call(callType, callId);
    await call.getOrCreate({
      data: {
        created_by_id: user.id,
        members: [
          { user_id: user.id, role: 'call_member' },
          { user_id: dietitianUserId, role: 'call_member' },
        ],
        custom: {
          source: 'truediet',
          mode: callMode,
          patientEmail: user.email,
        },
      },
    });

    const token = client.generateUserToken({ user_id: user.id });

    return c.json({
      callId,
      callType,
      callMode,
      token,
      userId: user.id,
      dietitianUserId,
      apiKey: getStreamApiKey(),
    });
  } catch (e: any) {
    return c.json({ error: 'stream_error', message: e?.message || 'Failed to create call' }, 500);
  }
});

// GET /api/stream/call/:callId - fetch call details (members only)
streamRoutes.get('/call/:callId', async (c) => {
  const user = c.get('user') as { id: string };
  const client = getStreamClient();
  if (!client || !isStreamConfigured()) {
    return c.json({ error: 'not_configured', message: 'Stream is not configured' }, 503);
  }
  const callType = c.req.query('callType') || 'default';
  const callId = c.req.param('callId');
  try {
    const call = client.video.call(callType, callId);
    const resp = await call.get();
    const callData: any = (resp as any)?.call || resp;
    const members = callData?.members || [];
    const isMember = members.some((m: any) => m?.user_id === user.id);
    if (!isMember) {
      return c.json({ error: 'forbidden', message: 'Not a member of this call' }, 403);
    }
    return c.json({ call: callData });
  } catch (e: any) {
    return c.json({ error: 'stream_error', message: e?.message || 'Failed to fetch call' }, 500);
  }
});

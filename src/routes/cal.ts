import { Hono } from 'hono';
import { auth } from '../lib/auth.js';
import { fetchCalSlots, getCalConfigData, isCalConfigured, makeCalBooking } from '../lib/cal.js';

type Variables = {
  user?: { id: string; name: string; email: string };
};

export const calRoutes = new Hono<{ Variables: Variables }>();

// 1. GET /api/cal/config (Public - returns whether Cal.com is set up & event type)
calRoutes.get('/config', (c) => {
  return c.json(getCalConfigData());
});

// 2. GET /api/cal/slots?dateFrom=...&dateTo=...&eventTypeId=... (Public availability lookup)
calRoutes.get('/slots', async (c) => {
  if (!isCalConfigured()) {
    return c.json({ error: 'not_configured', message: 'Cal.com API key is not configured.' }, 503);
  }

  const dateFrom = c.req.query('dateFrom') || c.req.query('startTime');
  const dateTo = c.req.query('dateTo') || c.req.query('endTime');
  const eventTypeId = c.req.query('eventTypeId');

  if (!dateFrom || !dateTo) {
    return c.json({ error: 'bad_request', message: 'dateFrom and dateTo are required query parameters.' }, 400);
  }

  try {
    const slots = await fetchCalSlots(dateFrom, dateTo, eventTypeId);
    return c.json(slots);
  } catch (err: any) {
    return c.json({ error: 'cal_error', message: err?.message || 'Failed to fetch slots from Cal.com' }, 500);
  }
});

// 3. POST /api/cal/bookings (Requires an authenticated session)
calRoutes.post('/bookings', async (c) => {
  if (!isCalConfigured()) {
    return c.json({ error: 'not_configured', message: 'Cal.com API key is not configured.' }, 503);
  }

  // Booking a real appointment on a dietitian's calendar must be tied to a
  // real account, otherwise anyone could book or spam the calendar.
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session?.user) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const { start, eventTypeId, notes, timeZone } = body;

  const config = getCalConfigData();
  const targetEventTypeId = eventTypeId || config.eventTypeId;

  if (!start || typeof start !== 'string') {
    return c.json({ error: 'bad_request', message: 'Start time is required.' }, 400);
  }
  const parsedStart = new Date(start);
  if (Number.isNaN(parsedStart.getTime())) {
    return c.json({ error: 'bad_request', message: 'Start time must be a valid ISO-8601 timestamp.' }, 400);
  }
  if (!targetEventTypeId) {
    return c.json({ error: 'bad_request', message: 'eventTypeId is required.' }, 400);
  }

  // The attendee identity always comes from the session, never from the
  // request body.
  const bookerName = session.user.name || 'True Diet Member';
  const bookerEmail = session.user.email;

  const safeNotes = typeof notes === 'string' ? notes.trim().slice(0, 2000) : undefined;
  const safeTimeZone = typeof timeZone === 'string' && /^[A-Za-z_+-]+\/[A-Za-z_+-]+$/.test(timeZone)
    ? timeZone
    : undefined;

  try {
    const booking = await makeCalBooking({
      eventTypeId: targetEventTypeId,
      start: parsedStart.toISOString(),
      name: bookerName,
      email: bookerEmail,
      notes: safeNotes,
      timeZone: safeTimeZone,
    });
    return c.json(booking, 201);
  } catch (err: any) {
    return c.json({ error: 'booking_failed', message: err?.message || 'Failed to create Cal.com booking' }, 502);
  }
});

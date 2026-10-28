// Cal.com configuration.
//
// Every value is read lazily inside the functions. Reading `process.env` at
// module-evaluation time would depend on the import order of
// `dotenv.config()`, which is fragile.
function getApiKey(): string | undefined {
  return process.env.CAL_API_KEY;
}

function getEventTypeId(): string | undefined {
  return process.env.CAL_EVENT_TYPE_ID;
}

function getCalApiBase(): string {
  return process.env.CAL_API_URL || 'https://api.cal.com/v2';
}

export function isCalConfigured(): boolean {
  return Boolean(getApiKey());
}

export function getCalConfigData() {
  const eventTypeId = getEventTypeId();
  return {
    configured: isCalConfigured(),
    eventTypeId: eventTypeId ? Number(eventTypeId) : undefined,
    username: process.env.CAL_USERNAME || undefined,
  };
}

export async function fetchCalSlots(startTime: string, endTime: string, overrideEventTypeId?: string | number) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Cal.com is not configured on the server. Please set CAL_API_KEY.');
  }

  const targetEventTypeId = overrideEventTypeId || getEventTypeId();
  if (!targetEventTypeId) {
    throw new Error('CAL_EVENT_TYPE_ID is required to fetch available slots.');
  }

  // Cal.com v2 expects /v2/slots/available?startTime=...&endTime=...&eventTypeId=...
  const params = new URLSearchParams({
    startTime,
    endTime,
    eventTypeId: String(targetEventTypeId),
  });

  const url = `${getCalApiBase()}/slots/available?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cal.com API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  // Cal.com v2 wraps slots inside data.data.slots
  const slots = data?.data?.slots || data?.slots || {};
  return { slots };
}

export async function makeCalBooking(data: {
  eventTypeId: string | number;
  start: string;
  name: string;
  email: string;
  notes?: string;
  timeZone?: string;
}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Cal.com is not configured on the server. Please set CAL_API_KEY.');
  }

  const url = `${getCalApiBase()}/bookings`;

  const payload = {
    start: data.start,
    eventTypeId: Number(data.eventTypeId) || Number(getEventTypeId()),
    attendee: {
      name: data.name,
      email: data.email,
      timeZone: data.timeZone || 'UTC',
    },
    notes: data.notes || '',
    metadata: {
      source: 'truediet_mobile_app',
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create Cal.com booking (${response.status}): ${errText}`);
  }

  const json = await response.json();
  const bookingData = json?.data || json;

  // Never fabricate a successful booking. If Cal.com did not confirm an id
  // and a status, the booking cannot be reported as accepted.
  const id = bookingData?.id;
  const status = bookingData?.status;
  if (!id || !status) {
    throw new Error('Cal.com did not return a booking confirmation.');
  }

  return {
    id,
    uid: bookingData?.uid,
    startTime: bookingData?.start || data.start,
    endTime: bookingData?.end,
    meetingUrl: bookingData?.meetingUrl || bookingData?.location || (bookingData?.references?.[0]?.meetingUrl),
    status,
  };
}

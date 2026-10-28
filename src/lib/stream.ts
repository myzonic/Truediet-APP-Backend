import { StreamClient } from '@stream-io/node-sdk';

// Credentials are read from the environment only. There are no inline
// fallbacks: a missing key must be a visible configuration error rather than
// a silently working service with a leaked secret.
//
// The values are read lazily inside each function. Reading `process.env` at
// module-evaluation time would depend on the import order of `dotenv.config()`,
// which is fragile.
export function isStreamConfigured(): boolean {
  return Boolean(process.env.STREAM_API_KEY && process.env.STREAM_API_SECRET);
}

export function getStreamClient(): StreamClient | null {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;
  if (!apiKey || !apiSecret) {
    return null;
  }
  return new StreamClient(apiKey, apiSecret);
}

export function getStreamApiKey(): string {
  return process.env.STREAM_API_KEY || '';
}

export function getStreamAppId(): string {
  return process.env.STREAM_APP_ID || '';
}

export function getDietitianUserId(): string {
  return process.env.STREAM_DIETITIAN_USER_ID || 'dietitian-maureen';
}

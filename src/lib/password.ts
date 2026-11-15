import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Password hashing using scrypt, a memory-hard KDF built into Node.js.
// No external native module is required, so the backend keeps working with a
// plain `npm install`.
// Hash format: "scrypt:<salt>:<hex-encoded derived key>"

const SCRYPT_KEY_LENGTH = 64;

// Password hashing with scrypt
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

// Password verification
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  try {
    const [algo, salt, hash] = hashedPassword.split(":");
    if (algo !== "scrypt" || !salt || !hash) {
      return false;
    }

    const candidate = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
    const expected = Buffer.from(hash, "hex");

    if (candidate.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// JWT creation
export async function createJWT(userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { userId, email, iat: now, exp: now + 60 * 60 * 24 * 7 };
  const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return token;
}

// JWT verification
export async function verifyJWT(token: string): Promise<{ userId: string; email: string } | null> {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) {
      return null;
    }

    return { userId: payload.userId, email: payload.email || "" };
  } catch {
    return null;
  }
}

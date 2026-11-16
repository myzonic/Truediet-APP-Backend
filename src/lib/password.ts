import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

/**
 * Custom authentication password hashing & signed JWT utilities.
 *
 * - New passwords use bcrypt (cost factor 12) as required by the security spec.
 * - Verification supports:
 *   1. bcrypt hashes (`$2a$`, `$2b$`, `$2y$`)
 *   2. scrypt hashes (`scrypt:<saltHex>:<keyHex>`)
 *   3. legacy `<saltHex>:<keyHex>` scrypt hashes from the original database
 *   so existing production accounts continue signing in seamlessly without any
 *   database reset.
 * - JWTs are HMAC-SHA256 signed (`header.payload.signature`) with secret key
 *   derived from `JWT_SECRET || AUTH_SECRET || BETTER_AUTH_SECRET`, while still
 *   accepting legacy unsigned tokens during rolling upgrades if needed.
 */

const SCRYPT_KEY_LENGTH = 64;
const BCRYPT_ROUNDS = 12;

function getJwtSecret(): string {
  return (
    process.env.JWT_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    "truediet-production-jwt-signing-secret-v1"
  );
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  try {
    if (!hashedPassword) return false;

    // 1. Standard bcrypt hash ($2a$, $2b$, $2y$)
    if (hashedPassword.startsWith("$2a$") || hashedPassword.startsWith("$2b$") || hashedPassword.startsWith("$2y$")) {
      return await bcrypt.compare(password, hashedPassword);
    }

    // 2. scrypt:<salt>:<hash>
    if (hashedPassword.startsWith("scrypt:")) {
      const [, salt, hash] = hashedPassword.split(":");
      if (!salt || !hash) return false;
      const candidate = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
      const expected = Buffer.from(hash, "hex");
      if (candidate.length !== expected.length) return false;
      return timingSafeEqual(candidate, expected);
    }

    // 3. Legacy <salt>:<hash> scrypt format
    if (hashedPassword.includes(":")) {
      const [salt, hash] = hashedPassword.split(":");
      if (!salt || !hash) return false;
      const candidate = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH);
      const expected = Buffer.from(hash, "hex");
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return true;
      }
      const candidateRaw = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
      if (candidateRaw.length === expected.length && timingSafeEqual(candidateRaw, expected)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export async function createJWT(userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      email,
      jti: randomBytes(8).toString("hex"),
      iat: now,
      exp: now + 60 * 60 * 24 * 7,
    })
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sig = createHmac("sha256", getJwtSecret()).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export async function verifyJWT(token: string): Promise<{ userId: string; email: string } | null> {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length === 3) {
      const [header, payloadB64, sig] = parts;
      const expectedSig = createHmac("sha256", getJwtSecret())
        .update(`${header}.${payloadB64}`)
        .digest("base64url");
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < now || !payload.userId) {
        return null;
      }
      return { userId: String(payload.userId), email: String(payload.email || "") };
    }

    // Legacy single-segment base64url token fallback for already-signed-in clients
    if (parts.length === 1) {
      const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < now || !payload.userId) {
        return null;
      }
      return { userId: String(payload.userId), email: String(payload.email || "") };
    }

    return null;
  } catch {
    return null;
  }
}

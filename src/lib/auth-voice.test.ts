import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, createJWT, verifyJWT } from "./password.js";
import { parseTranscriptIntoFoodItems } from "../routes/voice.js";

test("bcrypt password hashing and verification works", async () => {
  const hash = await hashPassword("StrongPass123!");
  assert.ok(hash.startsWith("$2"), `Expected bcrypt hash prefix, got ${hash.slice(0, 6)}`);
  const ok = await verifyPassword("StrongPass123!", hash);
  assert.equal(ok, true);
  const bad = await verifyPassword("WrongPassword", hash);
  assert.equal(bad, false);
});

test("HMAC-SHA256 JWT creation and verification rejects tampering", async () => {
  const token = await createJWT("user-123", "member@true-diet.com");
  assert.equal(token.split(".").length, 3);

  const verified = await verifyJWT(token);
  assert.deepEqual(verified, { userId: "user-123", email: "member@true-diet.com" });

  const tampered = token.slice(0, -4) + "xxxx";
  const rejected = await verifyJWT(tampered);
  assert.equal(rejected, null);
});

test("parseTranscriptIntoFoodItems extracts meal type, quantities, units, and reference nutrition", () => {
  const res = parseTranscriptIntoFoodItems(
    "I had two boiled eggs, two slices of whole wheat toast and one cup of milk for breakfast."
  );
  assert.equal(res.mealType, "breakfast");
  assert.equal(res.items.length, 3);
  assert.equal(res.items[0].quantity, "2");
  assert.equal(res.items[0].calories, 156);
  assert.equal(res.items[1].quantity, "2");
  assert.equal(res.items[1].unit, "slices");
  assert.equal(res.items[2].quantity, "1");
  assert.equal(res.items[2].unit, "cup");
});

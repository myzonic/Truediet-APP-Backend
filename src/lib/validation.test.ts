import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGE_LENGTH,
  nextDay,
  normalizeEmail,
  normalizeMealType,
  isValidEmail,
  parseLimit,
  resolveDay,
  validateMeal,
  validateMessageBody,
  validateRating,
} from "./validation.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
});

test("normalizeEmail returns empty string for non-strings", () => {
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(12345), "");
  assert.equal(normalizeEmail(null), "");
});

test("isValidEmail accepts sane addresses", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("user.name+tag@sub.domain.io"), true);
});

test("isValidEmail rejects malformed addresses", () => {
  assert.equal(isValidEmail("no-at-sign"), false);
  assert.equal(isValidEmail("missing@domain"), false);
  assert.equal(isValidEmail("spaces in@email.com"), false);
  assert.equal(isValidEmail(""), false);
});

test("parseLimit falls back for invalid input", () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit("0"), 50);
  assert.equal(parseLimit("-5"), 50);
  assert.equal(parseLimit("not-a-number"), 50);
});

test("parseLimit caps at max and floors decimals", () => {
  assert.equal(parseLimit("10"), 10);
  assert.equal(parseLimit("250"), 100);
  assert.equal(parseLimit("12.9"), 12);
});

test("validateMessageBody trims and accepts valid text", () => {
  const result = validateMessageBody("  hello there  ");
  assert.deepEqual(result, { value: "hello there", error: null });
});

test("validateMessageBody rejects empty or whitespace", () => {
  assert.deepEqual(validateMessageBody("   "), {
    value: null,
    error: "Message body is required",
  });
  assert.deepEqual(validateMessageBody(undefined), {
    value: null,
    error: "Message body is required",
  });
});

test("validateMessageBody rejects over-long text", () => {
  const long = "x".repeat(MAX_MESSAGE_LENGTH + 1);
  const result = validateMessageBody(long);
  assert.equal(result.value, null);
  assert.notEqual(result.error, null);
});

test("normalizeMealType accepts valid types case-insensitively", () => {
  assert.equal(normalizeMealType("Breakfast"), "breakfast");
  assert.equal(normalizeMealType(" SNACK "), "snack");
});

test("normalizeMealType rejects unknown types", () => {
  assert.equal(normalizeMealType("brunch"), null);
  assert.equal(normalizeMealType(undefined), null);
});

test("validateMeal returns a normalized meal type", () => {
  const result = validateMeal("Lunch");
  assert.deepEqual(result, { value: { mealType: "lunch", description: "" }, error: null });
});

test("validateMeal rejects invalid meal type", () => {
  const result = validateMeal("dinner-time");
  assert.equal(result.value, null);
  assert.notEqual(result.error, null);
});

test("validateRating allows empty and valid integers", () => {
  assert.deepEqual(validateRating(undefined), { value: null, error: null });
  assert.deepEqual(validateRating(3), { value: 3, error: null });
  assert.deepEqual(validateRating("5"), { value: 5, error: null });
});

test("validateRating rejects out-of-range and non-integers", () => {
  assert.notEqual(validateRating(0).error, null);
  assert.notEqual(validateRating(6).error, null);
  assert.notEqual(validateRating(2.5).error, null);
});

test("resolveDay zeroes the time and parses date strings", () => {
  const d = resolveDay("2026-02-03");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("resolveDay falls back to now for invalid input", () => {
  const now = new Date("2026-02-03T15:30:00");
  const d = resolveDay("not-a-date", now);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getHours(), 0);
});

test("nextDay returns the following midnight", () => {
  const start = new Date("2026-02-03T00:00:00");
  const end = nextDay(start);
  assert.equal(end.getDate(), 4);
  assert.equal(end.getHours(), 0);
});

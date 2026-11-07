// Pure, dependency-free helpers so core request validation is unit-testable
// without a database or network.

export const MAX_MESSAGE_LENGTH = 2000;

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function parseLimit(value: unknown, fallback = 50, max = 100): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export type MessageValidation = { value: string | null; error: string | null };

export function validateMessageBody(value: unknown, max = MAX_MESSAGE_LENGTH): MessageValidation {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { value: null, error: "Message body is required" };
  if (text.length > max) return { value: null, error: `Message exceeds ${max} characters` };
  return { value: text, error: null };
}

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export function normalizeMealType(value: unknown): MealType | null {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (MEAL_TYPES as readonly string[]).includes(t) ? (t as MealType) : null;
}

export type MealValidation = { value: { mealType: MealType; description: string } | null; error: string | null };

export function validateMeal(value: unknown): MealValidation {
  const mealType = normalizeMealType(value);
  if (!mealType) return { value: null, error: `mealType must be one of ${MEAL_TYPES.join(", ")}` };
  return { value: { mealType, description: "" }, error: null };
}

export type RatingValidation = { value: number | null; error: string | null };

export function validateRating(value: unknown, min = 1, max = 5): RatingValidation {
  if (value === undefined || value === null || value === "") return { value: null, error: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return { value: null, error: `Rating must be an integer between ${min} and ${max}` };
  return { value: n, error: null };
}

export type WeightValidation = { value: string | null; error: string | null };

/**
 * Weight is stored as the text the member typed (same shape as profile.weight,
 * e.g. "72" or "72.5 kg"), but must start with a single number in a sane
 * range so the trend chart can parse it. Units are kept as typed.
 */
export function validateWeight(value: unknown): WeightValidation {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { value: null, error: "Weight is required" };
  if (raw.length > 32) return { value: null, error: "Weight must be 32 characters or fewer" };

  const match = raw.match(/^(\d{1,3}(?:\.\d{1,2})?)(.*)$/);
  if (!match) return { value: null, error: "Weight must be a number, for example 72 kg" };

  const n = Number(match[1]);
  const rest = match[2] ?? "";
  // Any further digit means the member typed more than one number ("5000").
  if (/\d/.test(rest)) return { value: null, error: "Weight must contain a single number, for example 72 kg" };
  if (n < 20 || n > 500) return { value: null, error: "Weight must be between 20 and 500" };

  return { value: raw, error: null };
}

export function resolveDay(value: unknown, now = new Date()): Date {
  const raw = typeof value === "string" ? value.trim() : "";
  const parsed = raw ? new Date(`${raw}T00:00:00`) : now;
  const d = Number.isNaN(parsed.getTime()) ? now : parsed;
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function nextDay(start: Date): Date {
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return end;
}

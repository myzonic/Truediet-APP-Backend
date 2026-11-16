import { Hono } from "hono";
import { getAuthUserFromRequest } from "../lib/session.js";

export const voiceRoutes = new Hono();

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB limit

const SUPPORTED_EXT = new Set(["m4a", "mp3", "mp4", "mpeg", "mpga", "ogg", "wav", "webm", "flac"]);

const NUTRITION_PROMPT =
  "Nutrition and food diary entry: breakfast, lunch, dinner, snack, eggs, toast, whole wheat, Greek yogurt, oatmeal, berries, chicken breast, salmon, brown rice, quinoa, avocado, olive oil, almonds, vegetables, salad, milk, water, grams, ounces, cups, tablespoons, slices, servings.";

export interface ProposedFoodItem {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  rawText: string;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  uncertain?: boolean;
}

// Trusted reference nutrition values for common whole foods (per standard unit)
const REFERENCE_FOODS: Array<{
  keywords: string[];
  name: string;
  defaultUnit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}> = [
  { keywords: ["egg", "eggs", "boiled egg", "scrambled egg"], name: "Egg (large)", defaultUnit: "large", calories: 78, protein: 6, carbs: 0.6, fat: 5.3 },
  { keywords: ["whole wheat toast", "wheat toast", "toast", "bread", "slice of bread"], name: "Whole wheat bread", defaultUnit: "slice", calories: 81, protein: 4, carbs: 14, fat: 1.1 },
  { keywords: ["milk", "cup of milk", "whole milk", "skim milk"], name: "Milk", defaultUnit: "cup", calories: 122, protein: 8, carbs: 12, fat: 4.8 },
  { keywords: ["oat", "oats", "oatmeal", "porridge"], name: "Oats (cooked)", defaultUnit: "cup", calories: 158, protein: 6, carbs: 27, fat: 3.2 },
  { keywords: ["greek yogurt", "yogurt"], name: "Greek yogurt", defaultUnit: "cup", calories: 146, protein: 20, carbs: 8, fat: 4 },
  { keywords: ["banana", "bananas"], name: "Banana", defaultUnit: "medium", calories: 105, protein: 1.3, carbs: 27, fat: 0.4 },
  { keywords: ["apple", "apples"], name: "Apple", defaultUnit: "medium", calories: 95, protein: 0.5, carbs: 25, fat: 0.3 },
  { keywords: ["berries", "blueberries", "strawberries", "raspberries"], name: "Mixed berries", defaultUnit: "cup", calories: 70, protein: 1, carbs: 17, fat: 0.5 },
  { keywords: ["chicken", "chicken breast", "grilled chicken"], name: "Chicken breast (cooked)", defaultUnit: "serving (100g)", calories: 165, protein: 31, carbs: 0, fat: 3.6 },
  { keywords: ["salmon", "baked salmon", "grilled salmon"], name: "Salmon (cooked)", defaultUnit: "serving (100g)", calories: 206, protein: 22, carbs: 0, fat: 12 },
  { keywords: ["rice", "brown rice", "white rice"], name: "Cooked rice", defaultUnit: "cup", calories: 216, protein: 5, carbs: 45, fat: 1.8 },
  { keywords: ["quinoa"], name: "Quinoa (cooked)", defaultUnit: "cup", calories: 222, protein: 8, carbs: 39, fat: 3.6 },
  { keywords: ["avocado"], name: "Avocado", defaultUnit: "half", calories: 160, protein: 2, carbs: 9, fat: 15 },
  { keywords: ["almonds", "nuts", "walnuts"], name: "Almonds", defaultUnit: "handful (28g)", calories: 164, protein: 6, carbs: 6, fat: 14 },
  { keywords: ["salad", "greens", "spinach", "lettuce"], name: "Mixed green salad", defaultUnit: "bowl", calories: 45, protein: 2, carbs: 8, fat: 0.5 },
  { keywords: ["coffee", "latte"], name: "Coffee", defaultUnit: "cup", calories: 5, protein: 0.3, carbs: 0, fat: 0 },
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  half: 0.5,
};

function detectMealType(text: string): "breakfast" | "lunch" | "dinner" | "snack" {
  const lower = text.toLowerCase();
  if (/\bbreakfast\b|\bmorning\b/.test(lower)) return "breakfast";
  if (/\blunch\b|\bmidday\b/.test(lower)) return "lunch";
  if (/\bdinner\b|\bsupper\b|\bevening\b/.test(lower)) return "dinner";
  if (/\bsnack\b/.test(lower)) return "snack";
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

export function parseTranscriptIntoFoodItems(text: string): {
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  items: ProposedFoodItem[];
} {
  const mealType = detectMealType(text);
  const cleaned = text
    .replace(/^(i\s+(had|ate|drank|logged|just had)|for\s+(breakfast|lunch|dinner|a\s+snack)|today\s+i\s+had)\s+/i, "")
    .replace(/\s+for\s+(breakfast|lunch|dinner|a?\s*snack)\.?$/i, "")
    .trim();

  const parts = cleaned
    .split(/(?:,|;|\band\b|\bwith\b|\bplus\b|\bthen\b|\n)+/i)
    .map((p) => p.trim().replace(/\.$/, ""))
    .filter((p) => p.length >= 2);

  const items: ProposedFoodItem[] = (parts.length ? parts : [cleaned]).filter(Boolean).map((segment, idx) => {
    const m = segment.match(
      /^(?:(a|an|one|two|three|four|five|six|half|\d+(?:\.\d+)?)\s+)?(?:(cups?|slices?|pieces?|bowls?|servings?|grams?|g|oz|ounces?|tbsp|tablespoons?|tsp|teaspoons?|glasses?|cans?)\s+(?:of\s+)?)?(.+)$/i
    );

    const rawQty = m?.[1]?.toLowerCase() || "1";
    const numQty = NUMBER_WORDS[rawQty] ?? (Number(rawQty) || 1);
    const unit = (m?.[2] || "serving").toLowerCase();
    const foodPhrase = (m?.[3] || segment).trim();
    const lowerFood = foodPhrase.toLowerCase();

    const ref = REFERENCE_FOODS.find((r) => r.keywords.some((k) => lowerFood.includes(k)));
    if (ref) {
      return {
        id: `item-${idx + 1}`,
        name: foodPhrase.charAt(0).toUpperCase() + foodPhrase.slice(1),
        quantity: String(numQty),
        unit: m?.[2] ? unit : ref.defaultUnit,
        rawText: segment,
        calories: Math.round(ref.calories * numQty),
        protein: Math.round(ref.protein * numQty * 10) / 10,
        carbs: Math.round(ref.carbs * numQty * 10) / 10,
        fat: Math.round(ref.fat * numQty * 10) / 10,
        uncertain: false,
      };
    }

    // Do not invent nutrition values when not matched in reference database
    return {
      id: `item-${idx + 1}`,
      name: foodPhrase.charAt(0).toUpperCase() + foodPhrase.slice(1),
      quantity: String(numQty),
      unit,
      rawText: segment,
      uncertain: true,
    };
  });

  return { mealType, items };
}

/**
 * POST /api/voice/transcribe
 *
 * Accepts either:
 * 1. `multipart/form-data` with a `file` field (and optional `language`), OR
 * 2. JSON `{ audioBase64: string, mimeType?: string, filename?: string, language?: string }`
 *
 * Forwards the audio to Groq's `whisper-large-v3-turbo` speech-to-text endpoint
 * using the server-side `GROQ_API_KEY`. Never logs audio contents or API keys.
 */
voiceRoutes.post("/transcribe", async (c) => {
  const user = await getAuthUserFromRequest(c);
  if (!user) {
    return c.json({ error: "unauthorized", message: "Please sign in to use Voice Food Log." }, 401);
  }

  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  if (!groqKey) {
    return c.json(
      {
        error: "groq_not_configured",
        message: "Voice transcription service is not configured on the server yet (GROQ_API_KEY missing).",
      },
      503
    );
  }

  let audioBytes: Uint8Array | null = null;
  let filename = "recording.m4a";
  let mimeType = "audio/m4a";
  let language = "en";

  const contentType = (c.req.header("content-type") || "").toLowerCase();

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      const langField = form.get("language");
      if (typeof langField === "string" && langField.trim()) {
        language = langField.trim().slice(0, 10);
      }
      if (!file || typeof (file as any).arrayBuffer !== "function") {
        return c.json({ error: "invalid_audio", message: "No audio file was provided." }, 400);
      }
      const f = file as File;
      filename = f.name || filename;
      mimeType = f.type || mimeType;
      const ab = await f.arrayBuffer();
      audioBytes = new Uint8Array(ab);
    } else {
      const body = await c.req.json().catch(() => ({}));
      if (typeof body?.language === "string" && body.language.trim()) {
        language = body.language.trim().slice(0, 10);
      }
      if (typeof body?.filename === "string" && body.filename.trim()) {
        filename = body.filename.trim();
      }
      if (typeof body?.mimeType === "string" && body.mimeType.trim()) {
        mimeType = body.mimeType.trim();
      }
      const b64 = typeof body?.audioBase64 === "string" ? body.audioBase64.trim() : "";
      if (!b64) {
        return c.json({ error: "invalid_audio", message: "No audio data was provided." }, 400);
      }
      const stripped = b64.replace(/^data:[^;]+;base64,/, "");
      audioBytes = new Uint8Array(Buffer.from(stripped, "base64"));
    }
  } catch {
    return c.json({ error: "invalid_request", message: "Could not read the uploaded audio." }, 400);
  }

  if (!audioBytes || audioBytes.byteLength < 256) {
    return c.json(
      { error: "empty_recording", message: "The recording was too short or silent. Tap the microphone and speak clearly." },
      400
    );
  }

  if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
    return c.json(
      { error: "file_too_large", message: "Audio recording exceeds the 20 MB limit. Please record a shorter note." },
      413
    );
  }

  const ext = (filename.split(".").pop() || "m4a").toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) {
    filename = `recording.m4a`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const outForm = new FormData();
    const blob = new Blob([new Uint8Array(audioBytes)], { type: mimeType || "audio/m4a" });
    outForm.append("file", blob, filename);
    outForm.append("model", GROQ_MODEL);
    outForm.append("response_format", "json");
    outForm.append("temperature", "0");
    outForm.append("prompt", NUTRITION_PROMPT);
    if (language && language !== "auto") {
      outForm.append("language", language);
    }

    const groqRes = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
      },
      body: outForm,
      signal: controller.signal,
    });

    if (!groqRes.ok) {
      const status = groqRes.status;
      if (status === 401 || status === 403) {
        console.error("[voice] Groq API authentication failed (check GROQ_API_KEY)");
        return c.json({ error: "groq_auth_error", message: "Voice transcription service credentials are invalid." }, 502);
      }
      if (status === 429) {
        return c.json({ error: "rate_limited", message: "Voice transcription is busy right now. Please wait a moment and try again." }, 429);
      }
      console.error(`[voice] Groq transcription failed with HTTP ${status}`);
      return c.json({ error: "transcription_failed", message: "Could not transcribe the recording. Please try again or type your meal." }, 502);
    }

    const data: any = await groqRes.json().catch(() => ({}));
    const text = typeof data?.text === "string" ? data.text.trim() : "";

    if (!text) {
      return c.json(
        { error: "no_speech_detected", message: "No speech was recognized. Try speaking a bit closer to the microphone." },
        422
      );
    }

    const parsed = parseTranscriptIntoFoodItems(text);

    return c.json({
      text,
      model: GROQ_MODEL,
      language,
      mealType: parsed.mealType,
      items: parsed.items,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return c.json({ error: "timeout", message: "Transcription timed out. Check your connection and try again." }, 504);
    }
    console.error("[voice] Transcription error:", err?.message || "unknown");
    return c.json({ error: "internal_error", message: "Could not process your recording. Please try again." }, 500);
  } finally {
    clearTimeout(timeout);
  }
});

// POST /api/voice/parse -> re-parse edited transcript text into structured food items
voiceRoutes.post("/parse", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return c.json({ error: "validation_error", message: "Text is required" }, 400);
  }
  const parsed = parseTranscriptIntoFoodItems(text);
  return c.json(parsed);
});

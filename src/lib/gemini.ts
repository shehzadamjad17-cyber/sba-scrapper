/**
 * Gemini wrapper with round-robin key rotation and sliding-window rate limiting.
 *
 * Mirrors the pattern used in the website at sba-ebsite/src/lib/gemini-parser.ts
 * but exports two primitives we need: generateContent (synthesis) and
 * embedContent (dedup + niche match).
 *
 * Reads GEMINI_API_KEYS env var (CSV of keys, e.g. "key1,key2,key3").
 * Each key gets 10 RPM (free tier). 5 keys = 50 RPM total.
 */
import { GoogleGenerativeAI, type SchemaType } from "@google/generative-ai";
import { logger } from "./logger";

export const GEMINI_GEN_MODEL = "gemini-2.5-flash";
// `text-embedding-004` returned 404 from v1beta — Google renamed the GA
// embedding model to `gemini-embedding-001`. Both produce comparable
// quality vectors; cosineSimilarity is dimension-agnostic so any dim works
// as long as all calls go through this same function (they do).
export const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const FREE_RPM_LIMIT = 10;

interface KeyState {
  callTimes: number[];
}

let _keys: string[] = [];
let _keyStates: KeyState[] = [];
let _currentKeyIdx = 0;
let _initialized = false;

function initKeys(): void {
  if (_initialized) return;
  const raw = process.env.GEMINI_API_KEYS || "";
  _keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  _keyStates = _keys.map(() => ({ callTimes: [] }));
  _initialized = true;

  if (_keys.length === 0) {
    logger.warn("No GEMINI_API_KEYS configured — Gemini calls will fail");
  } else {
    logger.info("Gemini key rotation initialized", { keyCount: _keys.length });
  }
}

function getAvailableKey(): { key: string; index: number } | null {
  initKeys();
  if (_keys.length === 0) return null;

  const now = Date.now();
  for (let offset = 0; offset < _keys.length; offset++) {
    const idx = (_currentKeyIdx + offset) % _keys.length;
    const state = _keyStates[idx];
    state.callTimes = state.callTimes.filter((t) => now - t < 60_000);
    if (state.callTimes.length < FREE_RPM_LIMIT) {
      _currentKeyIdx = idx;
      return { key: _keys[idx], index: idx };
    }
  }
  return null;
}

function recordCall(keyIndex: number): void {
  _keyStates[keyIndex].callTimes.push(Date.now());
}

async function waitForAvailableKey(maxWaitMs: number = 65_000): Promise<{ key: string; index: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const av = getAvailableKey();
    if (av) return av;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No Gemini key available after ${maxWaitMs}ms (rate-limited)`);
}

/**
 * Generate text with Gemini 2.5 Flash + structured-output (JSON) mode.
 * @returns the parsed JSON object matching the provided responseSchema
 */
export async function generateContent(opts: {
  prompt: string;
  responseSchema: { type: SchemaType; properties: Record<string, unknown>; required?: string[] };
  temperature?: number;
}): Promise<{ raw: string; parsed: unknown }> {
  const av = await waitForAvailableKey();
  recordCall(av.index);
  const client = new GoogleGenerativeAI(av.key);
  const model = client.getGenerativeModel({
    model: GEMINI_GEN_MODEL,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      responseMimeType: "application/json",
      // SchemaType.OBJECT etc. — the responseSchema arg is the Gemini SDK shape
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: opts.responseSchema as any,
    },
  });
  const result = await model.generateContent(opts.prompt);
  const raw = result.response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Gemini returned malformed JSON: ${err instanceof Error ? err.message : String(err)}\nRaw: ${raw.slice(0, 500)}`
    );
  }
  return { raw, parsed };
}

/**
 * Embed a single piece of text with gemini-embedding-001.
 * Returns a vector of the model's default dimensionality.
 */
export async function embedContent(text: string): Promise<number[]> {
  const av = await waitForAvailableKey();
  recordCall(av.index);
  const client = new GoogleGenerativeAI(av.key);
  const model = client.getGenerativeModel({ model: GEMINI_EMBED_MODEL });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/**
 * Cosine similarity between two vectors (0..1).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Centroid (mean vector) of N embeddings. Used for niche-keyword centroid.
 */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error("centroid: empty input");
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

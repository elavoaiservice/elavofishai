import { complete } from './llm';

// Claude-vision fish identification. Takes a catch photo (base64 data URL) and
// returns a best-effort species + size estimate the angler can then edit.

export interface CatchId {
  species: string | null; // common name, e.g. "Largemouth Bass"
  lengthInches: number | null;
  weightLbs: number | null;
  confidence: 'low' | 'medium' | 'high';
  notes: string; // short, human-facing
}

export interface IdentifyResult {
  ok: boolean;
  needsKey?: boolean;
  error?: string;
  result?: CatchId;
}

const MEDIA_RE = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/;

export async function identifyCatch(dataUrl: string, hint?: { lake?: string }): Promise<IdentifyResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, needsKey: true, error: 'AI is not configured yet.' };

  const m = MEDIA_RE.exec(dataUrl || '');
  if (!m) return { ok: false, error: 'That image could not be read.' };
  const mediaType = m[1] as 'image/png' | 'image/jpeg' | 'image/webp';
  const data = m[2];

  const prompt =
    `You are a North American freshwater fisheries expert. Identify the fish held/shown in this photo` +
    (hint?.lake ? ` (taken at ${hint.lake})` : '') +
    `. Estimate its length and weight using visible references (a hand ≈ 3.5in wide, rod, lure, cooler, etc.). ` +
    `Approximate is fine — anglers will fine-tune. ` +
    `Respond with ONLY a JSON object, no prose, no code fence:\n` +
    `{"species": string|null, "lengthInches": number|null, "weightLbs": number|null, ` +
    `"confidence": "low"|"medium"|"high", "notes": string}\n` +
    `species = common name (e.g. "Largemouth Bass"), or null if no fish is clearly visible. ` +
    `notes = one short sentence (identifying features you used, or why unsure). Keep weightLbs/lengthInches null if you truly can't tell.`;

  let text = '';
  try {
    const model = process.env.AI_VISION_MODEL || process.env.AI_PROFILE_MODEL || 'claude-opus-4-8';
    const r = await complete({
      feature: 'identify_catch',
      model,
      fallbackModel: process.env.AI_VISION_FALLBACK || '',
      prompt,
      maxTokens: 400,
      images: [{ mediaType, data }],
      validate: (t) => /\{[\s\S]*\}/.test(t),
    });
    text = r.text.trim();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[identify-catch] failed:', (e as Error).message);
    return { ok: false, error: 'Could not read that photo — try again, or fill the log in by hand.' };
  }

  // Pull the JSON object out of the response (tolerate stray text / fences).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, error: 'The AI could not read that photo — try a clearer shot.' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { ok: false, error: 'The AI could not read that photo — try a clearer shot.' };
  }

  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  };
  const conf = String(parsed.confidence || '').toLowerCase();
  const result: CatchId = {
    species: parsed.species && typeof parsed.species === 'string' ? parsed.species.trim().slice(0, 60) : null,
    lengthInches: num(parsed.lengthInches),
    weightLbs: num(parsed.weightLbs),
    confidence: conf === 'high' ? 'high' : conf === 'low' ? 'low' : 'medium',
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 240) : '',
  };
  return { ok: true, result };
}

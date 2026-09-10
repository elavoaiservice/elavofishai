import Anthropic from '@anthropic-ai/sdk';
import { recordUsage } from './aiUsage';

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
    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const model = process.env.AI_VISION_MODEL || process.env.AI_PROFILE_MODEL || 'claude-opus-4-8';
    const msg = await client.messages.create({
      model,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    await recordUsage({
      feature: 'identify_catch', model,
      inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens,
      // Prompt caching isn't in this SDK version's Usage type yet, but the API
      // sends it — read it defensively rather than dropping the cheapest tokens.
      cacheReadTokens: (msg.usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens ?? 0,
      ms: Date.now() - startedAt,
    });
  } catch {
    return { ok: false, error: 'Could not reach the AI just now — try again shortly.' };
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

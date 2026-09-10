import { complete } from './llm';
import { prisma } from '../db';
import { env } from '../env';

// Generate a starter fishing profile for a lake with Claude, cached in the DB.
// Layered UNDER community/friends data (see the plan's trust hierarchy). Never
// overwrites a hand-verified profile (e.g. Granbury). No API key → no-op: the
// generic engine (timing/weather/water/map) still works without a profile.
export async function generateLakeProfile(lakeId: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const model = process.env.AI_PROFILE_MODEL || 'claude-opus-4-8';
  if (!apiKey) return;
  const lake = await prisma.lake.findUnique({ where: { id: lakeId }, include: { profile: true } });
  if (!lake) return;
  if (lake.profile && lake.profile.source === 'hand_verified') return;

  const where = `${lake.name}${lake.region ? `, ${lake.region}` : ''}${lake.country ? `, ${lake.country}` : ''}`;
  const prompt =
    `You are a veteran fishing guide writing a concise, practical starter guide for a lake app. ` +
    `Lake: ${where} (approx ${lake.lat.toFixed(4)}, ${lake.lon.toFixed(4)}).\n\n` +
    `Return ONLY valid JSON (no prose, no code fence) with this exact shape:\n` +
    `{"summary": string, ` +
    `"species": [{"name": string, "months": number[12], "notes": string}], ` +
    `"seasonalCalendar": [{"month": string, "note": string}], ` +
    `"patterns": [string], ` +
    `"axisDeg": number|null, ` +
    `"regsUrl": string}\n\n` +
    `Rules: "months" is 12 integers 1-5 rating that species' activity Jan..Dec. ` +
    `"axisDeg" is the compass bearing 0-179 of the lake's LONG axis (0 = runs north-south, ` +
    `90 = east-west, 135 = northwest-southeast) — null if the lake is roughly round or you are unsure. ` +
    `List the 4-8 species actually common to THIS water. Keep notes tactical (where/when/what to throw). ` +
    `For "regsUrl", give the official state fish & wildlife regulations page URL — do NOT invent limit numbers. ` +
    `If you are unsure this specific water exists, still give sound guidance for its region and climate.`;

  let text = '';
  try {
    const r = await complete({
      feature: 'lake_profile',
      model,
      fallbackModel: process.env.AI_PROFILE_FALLBACK || '',
      prompt,
      maxTokens: 2500,
      validate: (t) => !!extractJson(t),
      lakeId: lake.id,
    });
    text = r.text;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[lake-profile] generation failed:', (e as Error).message);
    return;
  }

  const content = extractJson(text);
  if (!content) return;

  await prisma.lakeProfile.upsert({
    where: { lakeId },
    create: { lakeId, content, source: 'ai', model },
    update: { content, source: 'ai', model, generatedAt: new Date() },
  });
}

// Pull the first {...} JSON object out of a model response, tolerant of stray text.
function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

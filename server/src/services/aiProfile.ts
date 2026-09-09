import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db';
import { env } from '../env';

// Generate a starter fishing profile for a lake with Claude, cached in the DB.
// Layered UNDER community/friends data (see the plan's trust hierarchy). Never
// overwrites a hand-verified profile (e.g. Granbury). No API key → no-op: the
// generic engine (timing/weather/water/map) still works without a profile.
export async function generateLakeProfile(lakeId: string): Promise<void> {
  if (!env.anthropicApiKey) return;
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
    `"regsUrl": string}\n\n` +
    `Rules: "months" is 12 integers 1-5 rating that species' activity Jan..Dec. ` +
    `List the 4-8 species actually common to THIS water. Keep notes tactical (where/when/what to throw). ` +
    `For "regsUrl", give the official state fish & wildlife regulations page URL — do NOT invent limit numbers. ` +
    `If you are unsure this specific water exists, still give sound guidance for its region and climate.`;

  let text = '';
  try {
    const client = new Anthropic({ apiKey: env.anthropicApiKey });
    // Streamed to avoid request timeouts on longer generations.
    const stream = client.messages.stream({
      model: env.aiProfileModel,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.MessageCreateParamsStreaming);
    const msg = await stream.finalMessage();
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch {
    return; // leave profile pending; safe to retry later
  }

  const content = extractJson(text);
  if (!content) return;

  await prisma.lakeProfile.upsert({
    where: { lakeId },
    create: { lakeId, content, source: 'ai', model: env.aiProfileModel },
    update: { content, source: 'ai', model: env.aiProfileModel, generatedAt: new Date() },
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

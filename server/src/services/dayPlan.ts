import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db';
import { env } from '../env';

export interface DayPlanRequest {
  lakeId: string;
  date: string; // YYYY-MM-DD
  species: string;
  conditions?: unknown; // client-computed: weather, solunar windows, moon, water temp, best hours
  force?: boolean;
}

export interface DayPlanResult {
  ok: boolean;
  needsKey?: boolean;
  content?: unknown;
  generatedAt?: Date;
  daysOutAtGen?: number;
  source?: 'cache' | 'ai';
  error?: string;
}

function daysOut(date: string): number {
  const target = Date.parse(`${date}T12:00:00`);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 86400000));
}

export async function getOrGenerateDayPlan(req: DayPlanRequest): Promise<DayPlanResult> {
  const { lakeId, date, species } = req;
  if (!lakeId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !species) {
    return { ok: false, error: 'Need a lake, a date (YYYY-MM-DD), and a target species.' };
  }
  const out = daysOut(date);

  const cached = await prisma.dayPlan.findUnique({
    where: { lakeId_date_species: { lakeId, date, species } },
  });
  // Serve cache unless forced, unless it's gone stale, or unless we're now
  // closer to the day than when it was generated (the forecast has firmed up).
  if (cached && !req.force) {
    const stale = Date.now() - cached.generatedAt.getTime() > 12 * 3600000;
    const closer = out < cached.daysOutAtGen;
    if (!stale && !closer) {
      return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.AI_PROFILE_MODEL || "claude-opus-4-8";
  if (!apiKey) {
    // No key yet — hand back the cached plan if we have one, else signal needsKey.
    if (cached) return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, needsKey: true, error: 'AI is not configured yet (no API key).' };
  }

  const lake = await prisma.lake.findUnique({ where: { id: lakeId }, include: { profile: true } });
  if (!lake) return { ok: false, error: 'Lake not found.' };

  const where = `${lake.name}${lake.region ? `, ${lake.region}` : ''}`;
  const profileText = lake.profile ? JSON.stringify(lake.profile.content).slice(0, 4000) : 'none';
  const condText = req.conditions ? JSON.stringify(req.conditions).slice(0, 4000) : 'none provided';

  const prompt =
    `You are a veteran fishing guide building an hour-by-hour game plan.\n` +
    `Lake: ${where} (${lake.lat.toFixed(4)}, ${lake.lon.toFixed(4)}). Date: ${date} (${out} days out). Target: ${species}.\n` +
    `Lake profile (JSON, may be empty): ${profileText}\n` +
    `Conditions for the day (JSON: weather/solunar/moon/water temp/best hours, may be sparse): ${condText}\n\n` +
    `Return ONLY valid JSON (no prose, no code fence):\n` +
    `{"summary": string, ` +
    `"timeline": [{"time": string, "advice": string}], ` +
    `"lures": [string], ` +
    `"notes": string}\n\n` +
    `Rules: 4-7 timeline blocks across the fishable day (dawn to dusk), each tying location + presentation to the ` +
    `solunar windows and weather. Be specific to ${species} on THIS water and season. Keep each advice to 1-2 sentences. ` +
    `If conditions look tough, say so honestly. Do not invent regulations.`;

  let text = '';
  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.MessageCreateParamsStreaming);
    const msg = await stream.finalMessage();
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch {
    if (cached) return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'Could not reach the AI just now — try again shortly.' };
  }

  const content = extractJson(text);
  if (!content) {
    if (cached) return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'The AI response could not be read — try again.' };
  }

  const saved = await prisma.dayPlan.upsert({
    where: { lakeId_date_species: { lakeId, date, species } },
    create: { lakeId, date, species, content: content as object, daysOutAtGen: out, model },
    update: { content: content as object, daysOutAtGen: out, model, generatedAt: new Date() },
  });
  return { ok: true, content: saved.content, generatedAt: saved.generatedAt, daysOutAtGen: out, source: 'ai' };
}

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

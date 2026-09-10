import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db';
import { recordUsage } from './aiUsage';
import { env } from '../env';

export interface DayPlanRequest {
  lakeId: string;
  date: string; // YYYY-MM-DD
  species: string;
  conditions?: unknown; // client-computed: weather, solunar windows, moon, water temp, best hours
  force?: boolean;
  userId?: string; // who asked — for usage accounting
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
  // Day plans are generated while someone stares at a button, so they run on
  // the fast model by default — Opus took 24-27s in production, long enough
  // that phones and proxies gave up before the answer arrived. Lake profiles,
  // which are generated once and cached forever, keep AI_PROFILE_MODEL.
  const model = process.env.AI_PLAN_MODEL || "claude-sonnet-5";
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
    `Rules: 4-6 timeline blocks across the fishable day (dawn to dusk), each tying location + presentation to the ` +
    `feeding windows and weather. Be specific to ${species} on THIS water and season. ` +
    `Hard limits so the plan fits on a phone: "summary" under 30 words, each "advice" under 30 words, ` +
    `at most 5 lures, "notes" under 25 words. Plain language a working angler uses — no jargon. ` +
    `If conditions look tough, say so honestly. Do not invent regulations.`;

  let text = '';
  const startedAt = Date.now();
  try {
    // A hung call must fail rather than hold the HTTP request open forever.
    const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });
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
    await recordUsage({
      feature: 'day_plan', model,
      inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens,
      // Prompt caching isn't in this SDK version's Usage type yet, but the API
      // sends it — read it defensively rather than dropping the cheapest tokens.
      cacheReadTokens: (msg.usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens ?? 0,
      userId: req.userId ?? null, lakeId, ms: Date.now() - startedAt,
    });
    if (msg.stop_reason === 'max_tokens') {
      // eslint-disable-next-line no-console
      console.error(`[dayplan] ${model} hit the token ceiling for ${species} — JSON will be truncated`);
    }
  } catch (e) {
    // Swallowing this was why a failing generation looked like a mystery in the
    // logs: the request 400'd and nothing said why.
    // eslint-disable-next-line no-console
    console.error(`[dayplan] ${model} call failed:`, (e as Error).message);
    await recordUsage({ feature: 'day_plan', model, userId: req.userId ?? null, lakeId, ok: false, ms: Date.now() - startedAt });
    if (cached) return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'Could not reach the AI just now — try again shortly.' };
  }

  const content = extractJson(text);
  if (!content) {
    // eslint-disable-next-line no-console
    console.error(`[dayplan] could not parse ${text.length} chars from ${model}: ${text.slice(0, 200)}`);
    if (cached) return { ok: true, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'The AI response came back unreadable — try again.' };
  }

  const saved = await prisma.dayPlan.upsert({
    where: { lakeId_date_species: { lakeId, date, species } },
    create: { lakeId, date, species, content: content as object, daysOutAtGen: out, model },
    update: { content: content as object, daysOutAtGen: out, model, generatedAt: new Date() },
  });
  return { ok: true, content: saved.content, generatedAt: saved.generatedAt, daysOutAtGen: out, source: 'ai' };
}

/**
 * Pull the JSON object out of a model reply. First-brace-to-last-brace looks
 * fine until the model adds a closing line like "Tight lines! {good luck}" or
 * wraps the object in a code fence — then the slice swallows the extra text and
 * the parse dies on a complete, perfectly good response. Scan for the brace
 * that actually balances instead, ignoring braces inside strings.
 *
 * Exported for tests: this is the seam where a good generation gets thrown away.
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  // Strip a ```json fence if there is one.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf('{');
  if (start < 0) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null; // never balanced — truncated mid-object
}

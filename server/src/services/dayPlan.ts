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
  goal?: 'numbers' | 'trophy'; // keepers in the boat, or one big fish
  launch?: { name?: string; lat?: number; lon?: number; kind?: string } | null;
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
  const goal: 'numbers' | 'trophy' = req.goal === 'trophy' ? 'trophy' : 'numbers';
  if (!lakeId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !species) {
    return { ok: false, error: 'Need a lake, a date (YYYY-MM-DD), and a target.' };
  }
  const out = daysOut(date);

  const cached = await prisma.dayPlan.findUnique({
    where: { lakeId_date_species_goal: { lakeId, date, species, goal } },
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
  // Web search is billed per search ($10 / 1,000) on top of tokens, so it is
  // off unless an admin turns it on.
  const webSearch = /^(1|true|yes)$/i.test(process.env.AI_WEB_SEARCH || '');
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

  // "any" hands the species choice to the model — the honest option when
  // someone just wants to catch fish and doesn't care what kind.
  const anySpecies = species.toLowerCase() === 'any';
  const target = anySpecies
    ? `whatever is most likely to bite — YOU choose the species and say why in "summary"`
    : species;
  const goalLine = goal === 'trophy'
    ? `Goal: ONE BIG FISH. Fewer bites is fine. Favour the water, times and presentations that hold the largest fish, even if that means a slow day.`
    : `Goal: NUMBERS — keeper-size fish in the boat. Favour reliable, repeatable bites over a long-shot at a giant.`;
  const launch = req.launch && Number.isFinite(Number(req.launch.lat)) && Number.isFinite(Number(req.launch.lon))
    ? `Launching from ${req.launch.name || 'a marked launch point'} at ${Number(req.launch.lat).toFixed(4)}, ${Number(req.launch.lon).toFixed(4)}. ` +
      `Build the day around that starting point — order the stops so the running between them makes sense, and say roughly how far each is from the ramp.`
    : `No launch point given — keep the plan usable from anywhere on the lake.`;

  const prompt =
    `You are a veteran fishing guide building an hour-by-hour game plan.\n` +
    `Lake: ${where} (${lake.lat.toFixed(4)}, ${lake.lon.toFixed(4)}). Date: ${date} (${out} days out).\n` +
    `Target: ${target}\n${goalLine}\n${launch}\n` +
    `Lake profile (JSON, may be empty): ${profileText}\n` +
    `Conditions for the day (JSON: weather/solunar/moon/water temp/best hours, may be sparse): ${condText}\n\n` +
    (webSearch
      ? `You have web search. Look for recent, local information about THIS lake before planning — ` +
        `state fish & wildlife reports, marina and guide reports, tournament results, generation or release schedules, ` +
        `and recent angler reports. Weigh what you find in this order, highest first:\n` +
        `  1. Official state agency reports and gauge/generation data (most reliable)\n` +
        `  2. Local guides, marinas and bait shops reporting on THIS lake within the last 2 weeks\n` +
        `  3. Tournament results and club reports from this lake this season\n` +
        `  4. Angler forum and social posts — treat as weak, unverified signal; never the sole basis for advice\n` +
        `Recency beats authority when they conflict on what is biting right now; authority beats recency on ` +
        `regulations, safety and lake operations. Ignore anything about a different body of water, and ignore ` +
        `undated posts. If searches turn up nothing useful for this lake, say so in "notes" and plan from the ` +
        `conditions and profile instead — do not pad the plan with generic advice dressed up as a report.\n` +
        `Put anything you actually used in "sources" as {"title","url","asOf"} — at most 4, most useful first.\n\n`
      : '') +
    `Return ONLY valid JSON (no prose, no code fence):\n` +
    `{"summary": string, ` +
    `"timeline": [{"time": string, "advice": string}], ` +
    `"lures": [string], ` +
    (webSearch ? `"sources": [{"title": string, "url": string, "asOf": string}], ` : '') +
    `"notes": string}\n\n` +
    `Rules: 4-6 timeline blocks across the fishable day (dawn to dusk), each tying location + presentation to the ` +
    `feeding windows and weather. Be specific to this water and season. ` +
    `Hard limits so the plan fits on a phone: "summary" under 30 words, each "advice" under 30 words, ` +
    `at most 5 lures, "notes" under 25 words. Plain language a working angler uses — no jargon. ` +
    `If conditions look tough, say so honestly. Do not invent regulations, reports or sources.`;

  let text = '';
  const startedAt = Date.now();
  try {
    // A hung call must fail rather than hold the HTTP request open forever.
    const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });
    const stream = client.messages.stream({
      model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
      // Server-side web search. The tool type isn't in this SDK version's types
      // yet, hence the cast; the API accepts it.
      ...(webSearch
        ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] as unknown as Anthropic.Tool[] }
        : {}),
    } as Anthropic.MessageCreateParamsStreaming);
    const msg = await stream.finalMessage();
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const searches =
      (msg.usage as { server_tool_use?: { web_search_requests?: number } } | undefined)?.server_tool_use
        ?.web_search_requests ?? 0;
    await recordUsage({
      feature: 'day_plan', model, webSearches: searches,
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
    where: { lakeId_date_species_goal: { lakeId, date, species, goal } },
    create: { lakeId, date, species, goal, content: content as object, daysOutAtGen: out, model },
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

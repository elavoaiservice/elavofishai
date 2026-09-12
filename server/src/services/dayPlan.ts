import { complete } from './llm';
import { recentReports, reportsForPrompt } from './reports';
import { releaseFor, summarizeRelease } from './corps';
import { featuresForLake, snapStops, type Candidate } from './features';
import { rampsForLake } from './ramps';
import { prisma } from '../db';
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
  window?: { from?: string; to?: string } | null; // hours they can actually fish
  platform?: string; // boat | shore | kayak | pier
}

export interface DayPlanResult {
  id?: string; // so the client can rate this exact plan
  model?: string;
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
  // What this plan was built for. A cached plan whose inputs no longer match
  // (different hours, fishing from the bank now, launching elsewhere) is the
  // wrong plan, however fresh it is.
  const inputs = {
    from: req.window?.from || '',
    to: req.window?.to || '',
    platform: req.platform || 'boat',
    launch: req.launch?.name || '',
  };
  const sameInputs = (c: unknown) => {
    const prev = (c as { inputs?: typeof inputs } | null)?.inputs;
    if (!prev) return true; // generated before inputs were recorded
    return prev.from === inputs.from && prev.to === inputs.to &&
      prev.platform === inputs.platform && prev.launch === inputs.launch;
  };

  // Serve cache unless forced, unless it's gone stale, or unless we're now
  // closer to the day than when it was generated (the forecast has firmed up).
  if (cached && !req.force && sameInputs(cached.content)) {
    const stale = Date.now() - cached.generatedAt.getTime() > 12 * 3600000;
    const closer = out < cached.daysOutAtGen;
    if (!stale && !closer) {
      return { ok: true, id: cached.id, model: cached.model || undefined, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
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
    if (cached) return { ok: true, id: cached.id, model: cached.model || undefined, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
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
  const hours = inputs.from || inputs.to
    ? `They can fish ${inputs.from || 'first light'} to ${inputs.to || 'dark'} — build the plan INSIDE those hours only, and say up front if the best window of the day falls outside them.`
    : `No time limit given — plan the fishable day, dawn to dusk.`;
  const platform = ({
    shore: `Fishing from the BANK or wading. Every stop must be reachable on foot from shore — no boat-only structure, no long runs. Think access points, bank-adjacent depth changes, docks and riprap.`,
    kayak: `Fishing from a KAYAK or small craft. Keep the water covered modest, favour protected water, and treat heavy wind as a real limit.`,
    pier: `Fishing from a PIER or dock. The spot is fixed — plan depth, presentation and timing rather than moving.`,
    boat: `Fishing from a BOAT — the whole lake is reachable.`,
  } as Record<string, string>)[req.platform || 'boat'] || `Fishing from a BOAT.`;
  const launch = req.launch && Number.isFinite(Number(req.launch.lat)) && Number.isFinite(Number(req.launch.lon))
    ? `Launching from ${req.launch.name || 'a marked launch point'} at ${Number(req.launch.lat).toFixed(4)}, ${Number(req.launch.lon).toFixed(4)}. ` +
      `Build the day around that starting point — order the stops so the running between them makes sense, and say roughly how far each is from the ramp.`
    : `No launch point given — keep the plan usable from anywhere on the lake.`;

  // Real places the plan may point at. The model is never allowed to invent a
  // coordinate: it chooses from this list — OSM features, the ramps, and the
  // angler's own spots — and anything else it returns is dropped by
  // snapStops() before it reaches the map.
  const [features, rampList, ownSpots, ownWps] = await Promise.all([
    featuresForLake(lakeId, req.launch && Number.isFinite(Number(req.launch.lat)) ? { lat: Number(req.launch.lat), lon: Number(req.launch.lon) } : null).catch(() => []),
    rampsForLake(lakeId).then((r) => r.ramps).catch(() => []),
    req.userId ? prisma.spot.findMany({ where: { userId: req.userId, lakeId }, select: { name: true, lat: true, lon: true, notes: true }, take: 25 }) : Promise.resolve([]),
    req.userId ? prisma.waypoint.findMany({ where: { userId: req.userId, lakeId }, select: { name: true, lat: true, lon: true, kind: true }, take: 25 }) : Promise.resolve([]),
  ]);
  const candidates: Candidate[] = [
    ...features.map((f) => ({ name: f.name, lat: f.lat, lon: f.lon, kind: f.kind, hint: f.hint })),
    ...rampList.map((r) => ({ name: r.name, lat: r.lat, lon: r.lon, kind: 'ramp' })),
    ...ownSpots.map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, kind: 'your spot', hint: x.notes || undefined })),
    ...ownWps.map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, kind: x.kind ? `your waypoint (${x.kind})` : 'your waypoint' })),
  ];
  const placeList = candidates.length
    ? candidates.map((c) => `- ${c.name} [${c.kind}] ${c.lat.toFixed(4)},${c.lon.toFixed(4)}${c.hint ? ` — ${c.hint}` : ''}`).join('\n')
    : '';

  // Real reports about this water beat anything a model can infer. Agency feeds
  // and angler reports are already collected; put the recent ones in front of
  // it, dated and attributed.
  const reports = reportsForPrompt(await recentReports(lakeId).catch(() => []));

  // On a regulated lake, moving water beats almost everything else — fish set
  // up on current. Empty for lakes with no Corps project nearby.
  const release = await releaseFor(lakeId).catch(() => null);
  const releaseLine = release ? summarizeRelease(release) : '';

  const prompt =
    `You are a veteran fishing guide building an hour-by-hour game plan.\n` +
    `Lake: ${where} (${lake.lat.toFixed(4)}, ${lake.lon.toFixed(4)}). Date: ${date} (${out} days out).\n` +
    `Target: ${target}\n${goalLine}\n${platform}\n${hours}\n${launch}\n` +
    `Lake profile (JSON, may be empty): ${profileText}\n` +
    `Conditions for the day (JSON: weather/solunar/moon/water temp/best hours, may be sparse): ${condText}\n\n` +
    (releaseLine
      ? `Dam release / hydropower generation (USACE, last 24h): ${releaseLine}\n` +
        `On a regulated lake this drives where fish are: current pulls bait, and the bite often turns on and ` +
        `off with the water. Work it into the timeline, and say plainly in "notes" if the generation pattern ` +
        `matters more than the weather that day.\n\n`
      : '') +
    (reports
      ? `Recent reports about THIS lake — dated, newest first. An angler report is someone who was actually ` +
        `there; an agency report is official. Weigh these ABOVE your own general knowledge, and above ` +
        `anything you search for, when they disagree about what is biting right now. Note it in "notes" if ` +
        `they contradict the conditions:\n${reports}\n\n`
      : '') +
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
    (placeList
      ? `PLACES you may name, with their real coordinates (${candidates.length}). Every stop in "stops" MUST be one of these, ` +
        `copied exactly — name and coordinates. Do not invent places or coordinates; if none of these fit a part of the ` +
        `day, describe the water type in the timeline instead and leave it out of "stops". Prefer the angler's own spots ` +
        `and waypoints when they suit the pattern — they have caught fish there. Read the hints: they say why that kind ` +
        `of place holds fish, and "lookFor" should say what to look for ON ARRIVAL at that exact place (depth, cover, ` +
        `bait, where the shade or current is), not repeat the hint.\n${placeList}\n\n`
      : `No mapped places are known for this lake, so return "stops": [] and describe water types in the timeline.\n\n`) +
    `Return ONLY valid JSON (no prose, no code fence):\n` +
    `{"summary": string, ` +
    `"timeline": [{"time": string, "advice": string}], ` +
    `"stops": [{"name": string, "lat": number, "lon": number, "when": string, "lookFor": string}], ` +
    `"lures": [string], ` +
    (webSearch ? `"sources": [{"title": string, "url": string, "asOf": string}], ` : '') +
    `"notes": string}\n\n` +
    `Rules: 4-6 timeline blocks across the fishable day (dawn to dusk), each tying location + presentation to the ` +
    `feeding windows and weather. Be specific to this water and season. ` +
    `Hard limits so the plan fits on a phone: "summary" under 30 words, each "advice" under 30 words, ` +
    `at most 5 lures, at most 5 stops with "lookFor" under 30 words each, "notes" under 25 words. Plain language a working angler uses — no jargon. ` +
    `If conditions look tough, say so honestly. Do not invent regulations, reports or sources.`;

  let text = '';
  try {
    const r = await complete({
      feature: 'day_plan',
      model,
      fallbackModel: process.env.AI_PLAN_FALLBACK || '',
      prompt,
      maxTokens: 2000,
      webSearch,
      // A plan we can't parse is a failed plan, whatever the model says —
      // this is what makes the fallback fire on substance, not on vibes.
      validate: (t) => !!extractJson(t),
      userId: req.userId ?? null,
      lakeId,
    });
    text = r.text;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[dayplan] generation failed:`, (e as Error).message);
    if (cached) return { ok: true, id: cached.id, model: cached.model || undefined, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'Could not build a plan just now — try again shortly.' };
  }

  const parsed = extractJson(text);
  // Snap the stops to real places (and drop invented ones) before anything is
  // cached or shown — the map must never show a coordinate the model made up.
  if (parsed && typeof parsed === 'object') {
    (parsed as Record<string, unknown>).stops = snapStops((parsed as Record<string, unknown>).stops, candidates);
  }
  const content = parsed && typeof parsed === 'object' ? { ...(parsed as object), inputs } : parsed;
  if (!content) {
    // eslint-disable-next-line no-console
    console.error(`[dayplan] could not parse ${text.length} chars from ${model}: ${text.slice(0, 200)}`);
    if (cached) return { ok: true, id: cached.id, model: cached.model || undefined, content: cached.content, generatedAt: cached.generatedAt, daysOutAtGen: cached.daysOutAtGen, source: 'cache' };
    return { ok: false, error: 'The AI response came back unreadable — try again.' };
  }

  const saved = await prisma.dayPlan.upsert({
    where: { lakeId_date_species_goal: { lakeId, date, species, goal } },
    create: { lakeId, date, species, goal, content: content as object, daysOutAtGen: out, model },
    update: { content: content as object, daysOutAtGen: out, model, generatedAt: new Date() },
  });
  return { ok: true, id: saved.id, model, content: saved.content, generatedAt: saved.generatedAt, daysOutAtGen: out, source: 'ai' };
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

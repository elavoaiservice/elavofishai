/**
 * Minnesota's lake surveys.
 *
 * The DNR publishes no dated fishing report, but it does something rarer: it
 * nets a lake and counts what comes up. A survey says which species are
 * actually present, how many per net, and how big they run — evidence that no
 * amount of general knowledge can replace, and the sort of thing an angler
 * planning a trip to an unfamiliar lake most wants to know.
 *
 * Stored as an undated report, because a survey is a standing fact about the
 * water with its own date in the text, not this week's news.
 */
import { prisma } from '../db';

const DETAIL = 'https://maps.dnr.state.mn.us/cgi-bin/lakefinder/detail.cgi?type=lake_survey&id=';

/** DNR species codes, in the words anglers use. */
const SPECIES: Record<string, string> = {
  BLG: 'Bluegill', LMB: 'Largemouth bass', SMB: 'Smallmouth bass', WAE: 'Walleye', NOP: 'Northern pike',
  BLC: 'Black crappie', WHC: 'White crappie', YEP: 'Yellow perch', PMK: 'Pumpkinseed', ROC: 'Rock bass',
  MUE: 'Muskellunge', CCF: 'Channel catfish', BLB: 'Black bullhead', BRB: 'Brown bullhead', YEB: 'Yellow bullhead',
  BOF: 'Bowfin', WTS: 'White sucker', TLC: 'Tullibee', LAT: 'Lake trout', RBT: 'Rainbow trout', BNT: 'Brown trout',
};

export interface SurveyFish { species: string; perNet: number | null; avgLb: number | null }
export interface Survey { date: string | null; type: string | null; fish: SurveyFish[] }
export interface LakeSurvey {
  lake: string | null;
  acres: number | null;
  maxDepthFeet: number | null;
  surveys: Survey[];
}

function dedupe(fish: SurveyFish[]): SurveyFish[] {
  const best = new Map<string, SurveyFish>();
  for (const f of fish) {
    const cur = best.get(f.species);
    if (!cur || (f.perNet || 0) > (cur.perNet || 0)) best.set(f.species, f);
  }
  return [...best.values()];
}

/** Pull the useful shape out of a large and awkward payload. */
export function parseSurvey(json: unknown): LakeSurvey | null {
  const r = (json as { result?: Record<string, unknown> })?.result;
  if (!r || !r.lakeName) return null;
  const raw = Array.isArray(r.surveys) ? (r.surveys as Record<string, unknown>[]) : [];
  const surveys: Survey[] = raw
    .map((s) => {
      const catches = Array.isArray(s.fishCatchSummaries) ? (s.fishCatchSummaries as Record<string, unknown>[]) : [];
      return {
        date: s.surveyDate ? String(s.surveyDate) : null,
        type: s.surveyType ? String(s.surveyType) : null,
        // A survey nets the same species with several gear types, so a species
        // appears more than once. Keep the best catch rate for each — two
        // Bluegill lines read like a mistake, because it looks like one.
        fish: dedupe(
          catches
            .map((f) => ({
              species: SPECIES[String(f.species || '')] || String(f.species || ''),
              perNet: Number.isFinite(Number(f.CPUE)) ? Number(f.CPUE) : null,
              avgLb: Number.isFinite(Number(f.averageWeight)) ? Number(f.averageWeight) : null,
            }))
              .filter((f) => f.species && /^[A-Z][a-z]/.test(f.species) && (f.perNet ?? 0) > 0)
        )
          .sort((a, b) => (b.perNet || 0) - (a.perNet || 0))
          .slice(0, 8),
      };
    })
    .filter((s) => s.fish.length)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    lake: String(r.lakeName),
    acres: Number.isFinite(Number(r.areaAcres)) ? Number(r.areaAcres) : null,
    maxDepthFeet: Number.isFinite(Number(r.maxDepthFeet)) ? Number(r.maxDepthFeet) : null,
    surveys: surveys.slice(0, 2),
  };
}

/** The most recent survey, as a sentence a guide would say. */
export function surveySummary(s: LakeSurvey): string {
  const latest = s.surveys[0];
  if (!latest || !latest.fish.length) return '';
  const size = [
    s.acres ? `${Math.round(s.acres).toLocaleString('en-US')} acres` : '',
    s.maxDepthFeet ? `${s.maxDepthFeet} ft at its deepest` : '',
  ].filter(Boolean).join(', ');
  const fish = latest.fish
    .map((f) => `${f.species} ${f.perNet} per net${f.avgLb ? ` averaging ${f.avgLb} lb` : ''}`)
    .join('; ');
  return `Minnesota DNR survey${latest.date ? ` of ${latest.date}` : ''}${size ? ` — ${size}` : ''}. What came up in the nets: ${fish}. ` +
    `Numbers are fish per net, so they compare species on this lake rather than lakes with each other.`;
}

/** Fetch and store the survey for a Minnesota lake with a known DNR id. */
export async function attachSurvey(lakeId: string, dowId: string): Promise<boolean> {
  if (!/^\d{6,10}$/.test(dowId)) return false;
  try {
    const res = await fetch(`${DETAIL}${dowId}`, {
      headers: { 'User-Agent': 'ElavoFishAI/1.0 (https://elavofishai.elavoai.com)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const parsed = parseSurvey(await res.json());
    if (!parsed) return false;
    const body = surveySummary(parsed);
    if (!body) return false;
    const url = `${DETAIL}${dowId}`;
    await prisma.lakeReport.upsert({
      where: { lakeId_url: { lakeId, url } },
      create: { lakeId, source: 'survey', sourceName: 'Minnesota DNR lake survey', title: 'Lake survey', body, url, publishedAt: null },
      update: { body },
    });
    return true;
  } catch {
    return false;
  }
}

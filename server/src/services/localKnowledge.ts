/**
 * What this lake's own anglers have actually caught.
 *
 * Every other source in the app is somebody's general knowledge: an AI guide
 * written from what is published about a lake, an agency page, a seasonal
 * table that holds for most warmwater fisheries. This is the one source that
 * is only about THIS water — the catches people logged here — and where it
 * disagrees with the general picture it should win, because it is evidence.
 *
 * Two rules keep it honest:
 *  - a handful of catches is not a pattern. Below MIN_FOR_PATTERN a species is
 *    reported as a count and nothing more; no "best month" is claimed from
 *    three fish.
 *  - private catches are left out. Marking a catch private means "this is not
 *    for anyone else", and quietly rolling it into a statistic other anglers
 *    read would break that promise even though no single fish is identifiable.
 */
import { prisma } from '../db';

const MIN_FOR_PATTERN = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface SpeciesKnowledge {
  species: string;
  caught: number;
  anglers: number;
  avgLb: number | null;
  bestLb: number | null;
  byMonth: number[];
  bestMonths: string[];
  topLures: string[];
  /** The water temperatures these fish were actually caught at. */
  tempRange: { low: number; high: number; median: number } | null;
  /** The barometer they bit on most often, when enough catches recorded one. */
  bestTrend: string | null;
  /** True when there is enough here to call it a pattern rather than a count. */
  pattern: boolean;
}

export interface CatchRow {
  species: string | null;
  weight: number | null;
  lure: string | null;
  date: Date;
  userId: string;
  waterTempF?: number | null;
  pressureTrend?: string | null;
}

/**
 * Fold raw catches into per-species knowledge. Pure, so the rules about what
 * counts as a pattern can be tested without a database.
 */
export function summarise(rows: CatchRow[]): SpeciesKnowledge[] {
  const by = new Map<string, { rows: CatchRow[]; anglers: Set<string> }>();
  for (const r of rows) {
    const name = (r.species || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const hit = by.get(key) || { rows: [], anglers: new Set<string>() };
    hit.rows.push({ ...r, species: name });
    hit.anglers.add(r.userId);
    by.set(key, hit);
  }

  const out: SpeciesKnowledge[] = [];
  for (const { rows: list, anglers } of by.values()) {
    const byMonth = new Array(12).fill(0) as number[];
    for (const r of list) byMonth[r.date.getUTCMonth()] += 1;
    const weights = list.map((r) => r.weight).filter((w): w is number => typeof w === 'number' && w > 0);
    const lures = new Map<string, number>();
    for (const r of list) {
      const l = (r.lure || '').trim();
      if (l) lures.set(l, (lures.get(l) || 0) + 1);
    }
    const pattern = list.length >= MIN_FOR_PATTERN;
    // Real evidence about this water: the temperatures these fish ate at, and
    // the barometer they ate on. A handful of readings is not a range, so the
    // same MIN_FOR_PATTERN bar applies.
    const temps = list.map((r) => r.waterTempF).filter((t): t is number => typeof t === 'number' && t > 32 && t < 100).sort((a, b) => a - b);
    const tempRange = temps.length >= MIN_FOR_PATTERN
      ? { low: temps[0], high: temps[temps.length - 1], median: temps[Math.floor(temps.length / 2)] }
      : null;
    const trends = new Map<string, number>();
    for (const r of list) if (r.pressureTrend) trends.set(r.pressureTrend, (trends.get(r.pressureTrend) || 0) + 1);
    const topTrend = [...trends.entries()].sort((a, b) => b[1] - a[1])[0];
    const bestTrend = topTrend && topTrend[1] >= MIN_FOR_PATTERN ? topTrend[0] : null;
    // "Best months" only means something once there are enough fish that one
    // month can stand out from another.
    const peak = Math.max(...byMonth);
    const bestMonths = pattern && peak > 1
      ? byMonth.map((n, i) => (n >= Math.max(2, peak * 0.6) ? MONTHS[i] : '')).filter(Boolean)
      : [];
    out.push({
      species: list[0].species as string,
      caught: list.length,
      anglers: anglers.size,
      avgLb: weights.length ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 100) / 100 : null,
      bestLb: weights.length ? Math.max(...weights) : null,
      byMonth,
      bestMonths,
      topLures: pattern
        ? [...lures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l)
        : [],
      tempRange,
      bestTrend,
      pattern,
    });
  }
  return out.sort((a, b) => b.caught - a.caught);
}

/** What this lake's log says, for the planner and the species pages. */
export async function knowledgeFor(lakeId: string): Promise<SpeciesKnowledge[]> {
  const rows = await prisma.trip.findMany({
    // Private means private, even inside a statistic.
    where: { lakeId, visibility: { not: 'private' }, species: { not: null } },
    select: { species: true, weight: true, lure: true, date: true, userId: true, waterTempF: true, pressureTrend: true },
    orderBy: { date: 'desc' },
    take: 2000,
  });
  return summarise(rows);
}

/**
 * The same thing as a few lines for the AI prompt. Written so the model can
 * tell evidence from a handful of fish, because it is told to weigh this above
 * its own general knowledge.
 */
export function knowledgeForPrompt(k: SpeciesKnowledge[], now = new Date()): string {
  const useful = k.filter((s) => s.caught >= 2).slice(0, 8);
  if (!useful.length) return '';
  const month = MONTHS[now.getUTCMonth()];
  const lines = useful.map((s) => {
    const thisMonth = s.byMonth[now.getUTCMonth()];
    const bits = [`${s.caught} logged by ${s.anglers} angler${s.anglers === 1 ? '' : 's'}`];
    if (s.pattern && s.bestMonths.length) bits.push(`best months here: ${s.bestMonths.join(', ')}`);
    if (thisMonth) bits.push(`${thisMonth} in ${month}`);
    if (s.avgLb) bits.push(`average ${s.avgLb} lb, best ${s.bestLb} lb`);
    if (s.topLures.length) bits.push(`what worked: ${s.topLures.join(', ')}`);
    if (s.tempRange) bits.push(`caught here at ${s.tempRange.low}-${s.tempRange.high}°F water (most often around ${s.tempRange.median}°)`);
    if (s.bestTrend) bits.push(`most often on a ${s.bestTrend.replace('fast', ' fast')} barometer`);
    if (!s.pattern) bits.push('too few to be a pattern');
    return `- ${s.species}: ${bits.join('; ')}`;
  });
  return lines.join('\n');
}

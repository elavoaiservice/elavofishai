/**
 * Water clarity, from the EPA's Water Quality Portal.
 *
 * The app could tell an angler the water temperature and the lake level and
 * not one thing about how clear the water is — which is the first branch of
 * every playbook we hold. Crappie Moment starts there ("clarity sets the
 * pattern"); Tactical Bassin picks bait colour off it. We were asking the
 * angler to eyeball it.
 *
 * waterqualitydata.us aggregates state agencies, the USGS, volunteer monitoring
 * programmes and lake associations into one free API with no key, and it covers
 * every state. Secchi-disk readings — a white disk lowered until it disappears
 * — are the oldest and most widely collected clarity measurement there is.
 *
 * Three things shaped this, all found by probing the live API rather than
 * reading the docs:
 *
 * 1. IT IS NOT LIVE. Agencies sample monthly to quarterly and publish months
 *    later. Granbury's newest reading is ten months old. So this is a seasonal
 *    profile of a lake, not today's conditions, and every number it produces is
 *    labelled with its date. It must never be presented as a reading.
 *
 * 2. A BOUNDING BOX IS NOT A LAKE. Asking for a box around Lake Minnetonka
 *    returns 37 MB, and the nearest monitoring stations belong to Shaver,
 *    Louise and Marion — different lakes entirely. Reporting those as
 *    Minnetonka's clarity would be worse than reporting nothing. So stations
 *    are matched by NAME as well as type and position, and the stations used
 *    are always shown, so a bad match is visible rather than silent.
 *
 * 3. THE DATA HAS TYPOS AND IMPOSSIBLE VALUES. One Granbury station is called
 *    "LAKE GRANDBURY"; a Florida record is dated in the year 2805. The matcher
 *    tolerates a misspelling and the parser drops anything it cannot believe.
 */
import { prisma } from '../db';

const BASE = 'https://www.waterqualitydata.us/data';
const SECCHI = 'Depth, Secchi disk depth';
/** Six years is enough for a monthly profile without pulling a decade of rows. */
const YEARS = 6;
/** Refetched rarely on purpose: the upstream data moves quarterly at best. */
const MAX_AGE_MS = 30 * 86400_000;

export interface ClarityReading {
  at: string; // YYYY-MM-DD
  ft: number;
  station: string;
}

export interface ClarityStation {
  id: string;
  name: string;
  km: number;
}

export interface Clarity {
  /** Typical clarity for the month being asked about, in feet. */
  typicalFt: number | null;
  /** How many readings that typical figure rests on. */
  typicalFrom: number;
  /** The range across the whole record, as a rough expectation. */
  lowFt: number | null;
  highFt: number | null;
  /** The most recent actual reading, which is usually months old. */
  latest: ClarityReading | null;
  /** Median feet per calendar month, 1-12; null where nothing was sampled. */
  byMonth: (number | null)[];
  /** clear | stained | muddy — the bucket the playbooks branch on. */
  band: 'clear' | 'stained' | 'muddy' | null;
  stations: ClarityStation[];
  readings: number;
  years: [number, number] | null;
  /**
   * Whether there is enough here to call it typical.
   *
   * Probing five lakes turned up two with a single reading from one station
   * eight kilometres away. That is an observation, not a pattern, and calling
   * it "typical for September" would be the app inventing confidence it does
   * not have.
   */
  enough: boolean;
}

// ---------- station matching ----------

/** Words that say what kind of water it is rather than which one. */
const NOISE =
  /\b(LAKE|LK|RESERVOIR|RES|POND|IMPOUNDMENT|IMP|THE|OF|AT|NEAR|NR|SITE|BASIN|MAIN|STEM|DAM|CHANNEL|ARM|BAY|CREEK|RIVER|BRANCH|FORK|ABOVE|ABV|BELOW|BLW|MILE|HWY|FM|SH|US|RD|ROAD|BRIDGE|DEEP|DEEPEST|POINT|CENTER|CENTRE|NORTH|SOUTH|EAST|WEST|UPPER|LOWER)\b/g;

export function nameTokens(s: string): string[] {
  const cleaned = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(NOISE, ' ');
  return cleaned.split(/\s+/).filter((t) => t.length > 2);
}

/** Crude edit-distance ratio — enough to forgive "GRANDBURY" for "GRANBURY". */
export function similar(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j];
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Does this station name refer to this lake?
 *
 * Every distinctive word in the lake's name has to appear in the station's,
 * give or take a typo. "Lower Lake Minnetonka" passes because "LOWER" and
 * "LAKE" are noise and "MINNETONKA" is there. "Shavers Lake - West basin"
 * fails, which is the entire point.
 */
export function stationMatchesLake(lakeName: string, stationName: string): boolean {
  const want = nameTokens(lakeName);
  if (!want.length) return false;
  const have = nameTokens(stationName);
  if (!have.length) return false;
  return want.every((t) => have.some((u) => u === t || similar(t, u) >= 0.85));
}

const LAKE_TYPE = /lake|reservoir|impoundment/i;

export interface StationRow {
  MonitoringLocationIdentifier?: string;
  MonitoringLocationName?: string;
  MonitoringLocationTypeName?: string;
  LatitudeMeasure?: string;
  LongitudeMeasure?: string;
}

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const p = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * p) / 2) ** 2 +
    Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(((bLon - aLon) * p) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The stations that are actually on this lake.
 *
 * Name and type both have to agree, and the station has to be near enough that
 * a shared name is not a coincidence — there is more than one Long Lake.
 */
export function pickStations(
  rows: StationRow[],
  lakeName: string,
  lat: number,
  lon: number,
  maxKm = 25
): ClarityStation[] {
  const out: ClarityStation[] = [];
  for (const r of rows) {
    const id = String(r.MonitoringLocationIdentifier || '');
    const name = String(r.MonitoringLocationName || '');
    if (!id || !LAKE_TYPE.test(String(r.MonitoringLocationTypeName || ''))) continue;
    if (!stationMatchesLake(lakeName, name)) continue;
    const sLat = Number(r.LatitudeMeasure);
    const sLon = Number(r.LongitudeMeasure);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
    const km = distanceKm(lat, lon, sLat, sLon);
    if (km > maxKm) continue;
    out.push({ id, name, km: Math.round(km * 10) / 10 });
  }
  out.sort((a, b) => a.km - b.km);
  return out;
}

// ---------- readings ----------

export interface ResultRow {
  ActivityStartDate?: string;
  MonitoringLocationIdentifier?: string;
  CharacteristicName?: string;
  ResultMeasureValue?: string;
  'ResultMeasure/MeasureUnitCode'?: string;
}

const M_TO_FT = 3.28084;

/** Secchi depths are published in metres, feet, inches or centimetres. */
export function toFeet(value: number, unit: string): number | null {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'm' || u === 'meters' || u === 'metres') return value * M_TO_FT;
  if (u === 'ft' || u === 'feet') return value;
  if (u === 'in' || u === 'inches') return value / 12;
  if (u === 'cm') return (value / 100) * M_TO_FT;
  return null;
}

/**
 * Believable readings only.
 *
 * A Secchi depth of zero is a disk that was never lowered, and the deepest
 * water ever recorded is about 80 ft; a Florida row carries the year 2805.
 * Anything outside the possible is dropped rather than averaged in.
 */
export function parseReadings(rows: ResultRow[]): ClarityReading[] {
  const out: ClarityReading[] = [];
  const thisYear = new Date().getUTCFullYear();
  for (const r of rows) {
    if (String(r.CharacteristicName || '') !== SECCHI) continue;
    const raw = Number(r.ResultMeasureValue);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ft = toFeet(raw, String(r['ResultMeasure/MeasureUnitCode'] || ''));
    if (ft == null || ft <= 0 || ft > 80) continue;
    const at = String(r.ActivityStartDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) continue;
    const year = Number(at.slice(0, 4));
    if (year < 1950 || year > thisYear) continue;
    out.push({ at, ft: Math.round(ft * 100) / 100, station: String(r.MonitoringLocationIdentifier || '') });
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The three buckets every playbook branches on.
 *
 * The thresholds come from how anglers actually talk: you can see a jig at
 * arm's length in clear water, a couple of feet in stained, and not at all in
 * muddy. Secchi depth is roughly the depth at which a light bait disappears,
 * which makes it a fair proxy for the decision being made.
 */
export const MIN_READINGS = 5;

export function bandFor(ft: number | null): Clarity['band'] {
  if (ft == null) return null;
  if (ft >= 4) return 'clear';
  if (ft >= 1.5) return 'stained';
  return 'muddy';
}

export function summarise(readings: ClarityReading[], stations: ClarityStation[], month: number): Clarity {
  const byMonth: (number | null)[] = new Array(12).fill(null);
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  for (const r of readings) buckets[Number(r.at.slice(5, 7)) - 1].push(r.ft);
  for (let i = 0; i < 12; i += 1) {
    const m = median(buckets[i]);
    byMonth[i] = m == null ? null : Math.round(m * 10) / 10;
  }
  const all = readings.map((r) => r.ft);
  const wanted = buckets[Math.min(Math.max(month, 1), 12) - 1];
  // Fall back to the whole record when this month has never been sampled —
  // better a yearly typical, clearly labelled, than nothing at all.
  const typical = wanted.length ? median(wanted) : median(all);
  const years: [number, number] | null = readings.length
    ? [Number(readings[0].at.slice(0, 4)), Number(readings[readings.length - 1].at.slice(0, 4))]
    : null;
  return {
    typicalFt: typical == null ? null : Math.round(typical * 10) / 10,
    typicalFrom: wanted.length || all.length,
    lowFt: all.length ? Math.round(Math.min(...all) * 10) / 10 : null,
    highFt: all.length ? Math.round(Math.max(...all) * 10) / 10 : null,
    latest: readings.length ? readings[readings.length - 1] : null,
    byMonth,
    band: bandFor(typical),
    stations,
    readings: readings.length,
    years,
    enough: readings.length >= 5,
  };
}

// ---------- fetching ----------

/** Minimal CSV reader: the portal quotes fields containing commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\r') continue;
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o: Record<string, string> = {};
    head.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

async function get(path: string, params: [string, string][]): Promise<string | null> {
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  try {
    const res = await fetch(`${BASE}/${path}?${qs}`, {
      headers: { accept: 'text/csv' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function boxFor(lake: { lat: number; lon: number; bbox?: string | null }): string {
  try {
    if (lake.bbox) {
      const b = JSON.parse(lake.bbox) as number[];
      if (Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n))) {
        // A small margin: monitoring stations sit at ramps and dams, sometimes
        // just outside a shoreline-traced box.
        const pad = 0.02;
        return `${b[0] - pad},${b[1] - pad},${b[2] + pad},${b[3] + pad}`;
      }
    }
  } catch { /* fall through to a box around the point */ }
  const d = 0.12; // roughly 8 miles
  return `${lake.lon - d},${lake.lat - d},${lake.lon + d},${lake.lat + d}`;
}

export interface ClarityData {
  readings: ClarityReading[];
  stations: ClarityStation[];
}

/** Live fetch. Returns null when the portal has nothing for this water. */
export async function fetchClarityData(lake: {
  name: string;
  lat: number;
  lon: number;
  bbox?: string | null;
}): Promise<ClarityData | null> {
  const stationCsv = await get('Station/search', [
    ['bBox', boxFor(lake)],
    ['mimeType', 'csv'],
    ['zip', 'no'],
  ]);
  if (!stationCsv) return null;
  const stations = pickStations(parseCsv(stationCsv) as StationRow[], lake.name, lake.lat, lake.lon);
  if (!stations.length) return null;

  // Twelve is plenty: they are sorted nearest-first, and one lake rarely has
  // more than a handful that actually report.
  const use = stations.slice(0, 12);
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - YEARS);
  const params: [string, string][] = [
    ...use.map((s) => ['siteid', s.id] as [string, string]),
    ['characteristicName', SECCHI],
    ['startDateLo', `01-01-${from.getUTCFullYear()}`],
    ['mimeType', 'csv'],
    ['zip', 'no'],
    ['dataProfile', 'narrowResult'],
  ];
  const resultCsv = await get('Result/search', params);
  if (!resultCsv) return null;
  const readings = parseReadings(parseCsv(resultCsv) as ResultRow[]);
  if (!readings.length) return null;
  // Only name the stations that actually produced something.
  const seen = new Set(readings.map((r) => r.station));
  return { readings, stations: use.filter((s) => seen.has(s.id)) };
}

/**
 * Cached clarity for a lake. The upstream data changes quarterly at best, so
 * this refreshes monthly and serves the stored copy in between — and stores
 * the raw readings rather than the summary, so the same cache answers for any
 * month without going back out.
 */
export async function clarityFor(lakeId: string, month?: number): Promise<Clarity | null> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { name: true, lat: true, lon: true, bbox: true, clarityJson: true, clarityAt: true },
  });
  if (!lake) return null;
  const m = month && month >= 1 && month <= 12 ? month : new Date().getUTCMonth() + 1;

  if (lake.clarityAt && Date.now() - lake.clarityAt.getTime() < MAX_AGE_MS) {
    if (!lake.clarityJson) return null; // we asked recently and there is nothing
    try {
      const cached = JSON.parse(lake.clarityJson) as ClarityData;
      if (cached.readings?.length) return summarise(cached.readings, cached.stations || [], m);
    } catch { /* fall through and re-fetch */ }
  }

  const live = await fetchClarityData(lake);
  // Stamp the attempt either way, so a lake the portal knows nothing about is
  // not re-asked on every page load.
  await prisma.lake
    .update({
      where: { id: lakeId },
      data: { clarityAt: new Date(), clarityJson: live ? JSON.stringify(live) : null },
    })
    .catch(() => null);
  return live ? summarise(live.readings, live.stations, m) : null;
}

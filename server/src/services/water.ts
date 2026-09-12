/**
 * Lake level and water temperature.
 *
 * This exists because the app spent its whole life asking USGS for a number
 * that does not exist. The client requested parameter 00062 from Lake
 * Granbury's gauge; that gauge has never published 00062 — its lake-elevation
 * series is 62614 — so the level panel showed "no reading" and blamed the
 * browser. Different gauges use different codes for the same thing, which is
 * exactly the sort of detail that belongs on the server once, not in a hard
 * coded query string.
 *
 * Three sources, in order of how much they are trusted:
 *   1. USGS, when a gauge on this lake publishes a level or temperature
 *   2. TWDB (Texas Water Development Board) — every major Texas reservoir,
 *      including the many with no USGS gauge, plus the official full-pool
 *      elevation, which is how we learn what "low" means for a new lake
 *   3. NOAA GLSEA satellite surface temperature, for the Great Lakes
 *
 * Nothing here ever throws at the route: a missing reading is a normal answer
 * for most lakes, and saying so plainly beats an error.
 */
import { prisma } from '../db';

/** Codes different USGS gauges use for the same measurement. */
export const ELEV_CODES = ['62614', '00062', '00065'];
export const TEMP_CODE = '00010';
const STALE_MS = 6 * 3600_000;

export interface Reading {
  value: number;
  at: string;
  source: 'usgs' | 'twdb' | 'glsea';
  stale: boolean;
}

interface OgcFeature {
  properties?: { parameter_code?: string; value?: string | number; unit_of_measure?: string; time?: string };
}

/** Newest reading for a set of parameter codes from the OGC latest-continuous response. */
export function pickOgc(json: unknown, codes: string[]): { value: number; unit: string; at: string } | null {
  const feats = ((json as { features?: OgcFeature[] })?.features || []) as OgcFeature[];
  let best: { value: number; unit: string; at: string } | null = null;
  for (const code of codes) {
    for (const f of feats) {
      const p = f.properties || {};
      if (p.parameter_code !== code) continue;
      const v = Number(p.value);
      if (!Number.isFinite(v)) continue;
      const at = String(p.time || '');
      if (!best || (at && at > best.at)) best = { value: v, unit: String(p.unit_of_measure || ''), at };
    }
    // Codes are in preference order: the first one that reports wins.
    if (best) return best;
  }
  return null;
}

/** °C → °F, unless the gauge already reports Fahrenheit. */
export function toF(value: number, unit: string): number {
  return /F/i.test(unit) && !/C/i.test(unit) ? value : value * 1.8 + 32;
}

export interface TwdbRow {
  full_name?: string;
  short_name?: string;
  condensed_name?: string;
  elevation?: number;
  percent_full?: number;
  conservation_pool_elevation?: number;
  timestamp?: string;
}

/**
 * Find a lake in TWDB's 122-reservoir file. Names differ ("Lake Granbury" vs
 * "Granbury" vs "GranburyLake"), so compare on letters alone — and require an
 * exact match on that, because "Palo Pinto" and "Palo Duro" are different
 * lakes 300 miles apart and a "contains" match would happily confuse them.
 */
export function matchTwdb(data: Record<string, TwdbRow>, lakeName: string): TwdbRow | null {
  const key = (s: string) => s.toLowerCase().replace(/\b(lake|reservoir|res|pool)\b/g, '').replace(/[^a-z]/g, '');
  const want = key(lakeName);
  if (!want) return null;
  for (const row of Object.values(data || {})) {
    for (const n of [row.full_name, row.short_name, row.condensed_name]) {
      if (n && key(n) === want) return row;
    }
  }
  return null;
}

/** ERDDAP returns a table: columnNames + rows. The temperature is in °C. */
export function parseGlsea(json: unknown): { value: number; at: string } | null {
  const t = (json as { table?: { columnNames?: string[]; rows?: unknown[][] } })?.table;
  if (!t?.columnNames || !t.rows?.length) return null;
  const iVal = t.columnNames.findIndex((c) => /sst|temp/i.test(c));
  const iTime = t.columnNames.findIndex((c) => /time/i.test(c));
  for (const row of t.rows) {
    const raw = row[iVal];
    // A gap in the satellite grid comes back as null, and Number(null) is 0 —
    // which would report 32°F on a lake nobody measured.
    if (raw === null || raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) return { value: v, at: String(row[iTime] || '') };
  }
  return null;
}

/** First-to-last change across a NWIS instantaneous-values series. */
export function deltaFromIv(json: unknown): number | null {
  const ts = (json as { value?: { timeSeries?: { values?: { value?: { value?: string }[] }[] }[] } })?.value?.timeSeries?.[0];
  const vs = (ts?.values?.[0]?.value || []).map((v) => Number(v.value)).filter((n) => Number.isFinite(n) && n > 0);
  if (vs.length < 5) return null;
  return Math.round((vs[vs.length - 1] - vs[0]) * 100) / 100;
}

async function getJson(url: string, ms = 10_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ElavoFishAI/1.0 (https://elavofishai.elavoai.com)' },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// TWDB's whole-state file is 73 KB and updates once a day; fetching it per
// lake per request would be rude and pointless.
let twdbCache: { at: number; data: Record<string, TwdbRow> } | null = null;
async function twdbAll(): Promise<Record<string, TwdbRow> | null> {
  if (twdbCache && Date.now() - twdbCache.at < 6 * 3600_000) return twdbCache.data;
  const json = (await getJson('https://www.waterdatafortexas.org/reservoirs/recent-conditions.json', 15_000)) as Record<string, TwdbRow> | null;
  if (!json) return twdbCache?.data || null;
  twdbCache = { at: Date.now(), data: json };
  return json;
}

const lakeCache = new Map<string, { at: number; value: WaterAnswer }>();

export interface WaterAnswer {
  level: { ft: number; fullPoolFt: number | null; deltaFt7d: number | null; at: string; source: 'usgs' | 'twdb'; stale: boolean } | null;
  waterTemp: { f: number; at: string; source: 'usgs' | 'glsea'; stale: boolean } | null;
  gauge: { id: string; name: string } | null;
  reason?: string;
}

const isStale = (at: string) => {
  const t = Date.parse(at);
  return !Number.isFinite(t) || Date.now() - t > STALE_MS;
};

/** Everything we can find out about this lake's water, cached 15 minutes. */
export async function waterFor(lakeId: string): Promise<WaterAnswer> {
  const hit = lakeCache.get(lakeId);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.value;

  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, name: true, region: true, lat: true, lon: true, gaugeId: true, fullPool: true },
  });
  if (!lake) return { level: null, waterTemp: null, gauge: null, reason: 'Unknown lake.' };

  const out: WaterAnswer = { level: null, waterTemp: null, gauge: lake.gaugeId ? { id: lake.gaugeId, name: '' } : null };
  let fullPool = lake.fullPool ?? null;

  // 1. The lake's own USGS gauge, if it has one that reports.
  if (lake.gaugeId) {
    const latest = await getJson(
      `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?monitoring_location_id=USGS-${encodeURIComponent(lake.gaugeId)}&f=json&limit=100`
    );
    const elev = pickOgc(latest, ELEV_CODES);
    if (elev) {
      // The 7-day change needs the series, not just the latest value; ask for
      // exactly the code this gauge turned out to use.
      const code = ((latest as { features?: OgcFeature[] })?.features || []).find((f) => Number(f.properties?.value) === elev.value)?.properties?.parameter_code
        || ELEV_CODES[0];
      const series = await getJson(`https://waterservices.usgs.gov/nwis/iv/?sites=${encodeURIComponent(lake.gaugeId)}&parameterCd=${code}&format=json&period=P7D`, 15_000);
      out.level = { ft: elev.value, fullPoolFt: fullPool, deltaFt7d: deltaFromIv(series), at: elev.at, source: 'usgs', stale: isStale(elev.at) };
    }
    const temp = pickOgc(latest, [TEMP_CODE]);
    if (temp) out.waterTemp = { f: Math.round(toF(temp.value, temp.unit) * 10) / 10, at: temp.at, source: 'usgs', stale: isStale(temp.at) };
  }

  // 2. Texas: TWDB covers reservoirs with no USGS gauge, and knows full pool.
  const inTexas = /\btexas\b|\bTX\b/i.test(lake.region || '');
  if (inTexas && (!out.level || out.level.stale)) {
    const all = await twdbAll();
    const row = all ? matchTwdb(all, lake.name) : null;
    if (row && Number.isFinite(Number(row.elevation))) {
      if (Number.isFinite(Number(row.conservation_pool_elevation))) fullPool = Number(row.conservation_pool_elevation);
      const at = row.timestamp ? `${row.timestamp}T12:00:00Z` : new Date().toISOString();
      out.level = { ft: Number(row.elevation), fullPoolFt: fullPool, deltaFt7d: out.level?.deltaFt7d ?? null, at, source: 'twdb', stale: isStale(at) };
    }
  }

  // 3. Great Lakes surface temperature, from NOAA's daily satellite grid.
  if (!out.waterTemp && /^lake (superior|michigan|huron|erie|ontario|st\.? clair)$/i.test(lake.name.trim())) {
    const url = `https://apps.glerl.noaa.gov/erddap/griddap/GLSEA_ACSPO_GCS.json?sst[(last)][(${lake.lat}):(${lake.lat})][(${lake.lon}):(${lake.lon})]`;
    const g = parseGlsea(await getJson(url, 15_000));
    if (g) out.waterTemp = { f: Math.round(toF(g.value, 'C') * 10) / 10, at: g.at, source: 'glsea', stale: isStale(g.at) };
  }

  if (out.level && fullPool != null) out.level.fullPoolFt = fullPool;
  // Learn full pool once: it is what turns a bare elevation into "4 ft low".
  if (fullPool != null && lake.fullPool == null) {
    await prisma.lake.update({ where: { id: lake.id }, data: { fullPool } }).catch(() => {});
  }
  if (!out.level && !out.waterTemp) {
    out.reason = lake.gaugeId
      ? 'The gauge on this lake reports neither level nor temperature right now.'
      : 'No gauge we can read covers this lake.';
  }

  lakeCache.set(lakeId, { at: Date.now(), value: out });
  return out;
}

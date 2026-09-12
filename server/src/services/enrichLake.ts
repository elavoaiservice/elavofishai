/**
 * Everything we can learn about a lake the moment someone adds it.
 *
 * Adding a lake used to store a name and a pair of coordinates and generate an
 * AI guide; the gauge and the ramps stayed empty until someone happened to look
 * for them. This fills in what public sources can tell us, best-effort and in
 * the background — a failure anywhere leaves the lake usable, just thinner.
 *
 * Sources, all free and keyless: USGS Water Services (gauges), OpenStreetMap
 * Overpass (ramps), and the Anthropic API (the written guide).
 */
import { prisma } from '../db';
import { ELEV_CODES, TEMP_CODE } from './water';
import { generateLakeProfile } from './aiProfile';
import { rampsForLake } from './ramps';
import { releaseFor } from './corps';
import { attachOfficialSource } from './agencySources';

/**
 * Nearest USGS monitoring location that reports water level.
 *
 * Uses the OGC API (api.waterdata.usgs.gov). The older
 * waterservices.usgs.gov/nwis/site service — the obvious choice — times out
 * consistently; it is part of the NWIS stack USGS is retiring. The `iv`
 * endpoint the app reads levels from still works, so discovery and reading
 * come from different services for now.
 */
export interface UsgsSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  miles: number;
  isLake: boolean;
  /** USGS classifies the site itself as a lake/reservoir (site_type_code LK). */
  isReservoir?: boolean;
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dy = (bLat - aLat) * 69.0;
  const dx = (bLon - aLon) * 69.0 * Math.cos(midLat);
  return Math.sqrt(dx * dx + dy * dy);
}

interface OgcFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

/**
 * Rank candidate sites for "which gauge tells me this lake's level".
 * Lake and reservoir sites win over stream gauges at any comparable distance —
 * a stream gauge five miles up the river says nothing about pool elevation.
 * Exported for tests.
 */
export function pickGauge(sites: UsgsSite[]): UsgsSite | null {
  if (!sites.length) return null;
  const sorted = [...sites].sort((a, b) => {
    if (a.isLake !== b.isLake) return a.isLake ? -1 : 1;
    return a.miles - b.miles;
  });
  const best = sorted[0];
  // A stream gauge is only worth adopting if it is genuinely close.
  if (!best.isLake && best.miles > 8) return null;
  return best;
}

export async function findGauge(lat: number, lon: number, radiusDeg = 0.3): Promise<UsgsSite | null> {
  const bbox = [
    (lon - radiusDeg).toFixed(4), (lat - radiusDeg).toFixed(4),
    (lon + radiusDeg).toFixed(4), (lat + radiusDeg).toFixed(4),
  ].join(',');
  const url =
    `https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items` +
    `?bbox=${bbox}&limit=200&f=json`;

  const res = await fetch(url, { headers: { 'User-Agent': 'ElavoFishAI/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const json = (await res.json()) as { features?: OgcFeature[] };

  const sites: UsgsSite[] = [];
  for (const f of json.features || []) {
    const p = f.properties || {};
    const id = String(p.monitoring_location_number || p.id || '');
    const name = String(p.monitoring_location_name || '');
    const type = String(p.site_type_code || '');
    const [lo, la] = f.geometry?.coordinates || [];
    if (!id || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
    // LK = lake/reservoir, ST = stream. Everything else (wells, springs)
    // has nothing to say about a fishing lake's level.
    if (type !== 'LK' && type !== 'ST') continue;
    sites.push({
      id, name, lat: Number(la), lon: Number(lo),
      miles: milesBetween(lat, lon, Number(la), Number(lo)),
      isLake: type === 'LK' || /\b(lk|lake|res|reservoir)\b/i.test(name),
      // USGS's own classification, not the name: "ELK R BL ELK CITY LK" is a
      // river that happens to have "LK" in its name.
      isReservoir: type === 'LK',
    });
  }
  // Nearest first, and every candidate has to prove itself before adoption.
  //
  // Two ways this went wrong before. Havana Lake was handed "Copan Lake near
  // Copan, OK" — 14 miles away, in another state, publishing nothing at all —
  // because being nearby with a promising name was the whole test. Then, with
  // a reporting check but a name-based idea of what a lake gauge is, it was
  // handed "ELK R BL ELK CITY LK, KS", a RIVER gauge whose 5.18 ft stage would
  // have been drawn on the page as a lake elevation. A number that looks real
  // and is meaningless is worse than an honest blank.
  const lakes = sites.filter((s) => s.isReservoir).sort((a, b) => a.miles - b.miles);
  for (const site of lakes.slice(0, 6)) {
    if (site.miles > 25) break;
    if (await gaugeReportsLevel(site.id)) return site;
  }
  return null;
}

/**
 * Does this site publish the level of a LAKE?
 *
 * 62614 and 00062 are reservoir elevations. 00065 is gage height, which on a
 * river is the depth over a datum — a fine number that has nothing to do with
 * how full a lake is — so it only counts at a site the USGS itself classifies
 * as a lake.
 */
export async function gaugeReportsLevel(siteId: string): Promise<boolean> {
  const codes = await gaugeCodes(siteId);
  return ELEV_CODES.some((c) => codes.has(c));
}

export async function gaugeCodes(siteId: string): Promise<Set<string>> {
  try {
    const res = await fetch(
      `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?monitoring_location_id=USGS-${encodeURIComponent(siteId)}&f=json&limit=100`,
      { headers: { 'User-Agent': 'ElavoFishAI/1.0 (https://elavofishai.elavoai.com)' }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return new Set();
    const json = (await res.json()) as { features?: { properties?: { parameter_code?: string } }[] };
    return new Set((json.features || []).map((f) => String(f.properties?.parameter_code || '')));
  } catch {
    return new Set();
  }
}

export interface EnrichResult {
  gauge?: string | null;
  ramps?: number;
  corps?: string | null;
  officialSource?: string | null;
  profile?: boolean;
  errors: string[];
}

/**
 * Fill in everything public sources know about a lake. Safe to re-run; never
 * throws. Each step is independent so one dead service doesn't block the rest.
 */
export async function enrichLake(lakeId: string): Promise<EnrichResult> {
  const result: EnrichResult = { errors: [] };
  const lake = await prisma.lake.findUnique({ where: { id: lakeId } });
  if (!lake) return { errors: ['no such lake'] };

  // 1. Water-level gauge — only if one isn't already set.
  if (!lake.gaugeId) {
    try {
      const site = await findGauge(lake.lat, lake.lon);
      if (site) {
        await prisma.lake.update({
          where: { id: lake.id },
          data: { gaugeId: site.id, gaugeSource: 'usgs' },
        });
        result.gauge = site.id;
      } else {
        result.gauge = null;
      }
    } catch (e) {
      result.errors.push(`gauge: ${(e as Error).message}`);
    }
  }

  // 2. Boat ramps (cached on the lake row by the ramps service).
  try {
    const { ramps } = await rampsForLake(lake.id);
    result.ramps = ramps.length;
  } catch (e) {
    result.errors.push(`ramps: ${(e as Error).message}`);
  }

  // 3. Dam releases, if this is a Corps project. The lookup is heavy (a
  //    district's location list is ~800KB) so it caches on the lake row and
  //    an empty result means "looked, nothing near" rather than "not tried".
  try {
    const rel = await releaseFor(lake.id);
    result.corps = rel ? `${rel.office}:${rel.project}` : null;
  } catch (e) {
    result.errors.push(`corps: ${(e as Error).message}`);
  }

  // 4. The state's own page for this lake, as a report source.
  try {
    const r = await attachOfficialSource(lake.id);
    result.officialSource = r.added ? r.url || null : null;
  } catch (e) {
    result.errors.push(`official source: ${(e as Error).message}`);
  }

  // 5. The written guide — species, seasons, patterns, regulations link.
  try {
    await generateLakeProfile(lake.id);
    const p = await prisma.lakeProfile.findUnique({ where: { lakeId: lake.id }, select: { id: true } });
    result.profile = !!p;
  } catch (e) {
    result.errors.push(`profile: ${(e as Error).message}`);
  }

  return result;
}

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
import { generateLakeProfile } from './aiProfile';
import { rampsForLake } from './ramps';

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
    });
  }
  return pickGauge(sites);
}

export interface EnrichResult {
  gauge?: string | null;
  ramps?: number;
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

  // 3. The written guide — species, seasons, patterns, regulations link.
  try {
    await generateLakeProfile(lake.id);
    const p = await prisma.lakeProfile.findUnique({ where: { lakeId: lake.id }, select: { id: true } });
    result.profile = !!p;
  } catch (e) {
    result.errors.push(`profile: ${(e as Error).message}`);
  }

  return result;
}

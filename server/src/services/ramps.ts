/**
 * Boat ramps for a lake, from OpenStreetMap via Overpass (free, no key —
 * same footing as the Nominatim lake search).
 *
 * Ramps are tagged `leisure=slipway` in OSM, sometimes with `boat=yes` or as
 * part of a marina. Results are cached per lake because Overpass is a shared
 * volunteer service: hammering it on every plan form open would be rude and
 * slow. A lake with no mapped ramps caches the empty answer too, so we don't
 * re-ask on every visit.
 */
import { prisma } from '../db';

export interface Ramp {
  name: string;
  lat: number;
  lon: number;
  osmRef?: string;
  named?: boolean; // came with a real name in OSM, rather than one we made up
}

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const CACHE_DAYS = 30;
const DEFAULT_RADIUS_M = 12000;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Miles between two points (equirectangular is plenty at lake scale). */
export function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dy = (bLat - aLat) * 69.0;
  const dx = (bLon - aLon) * 69.0 * Math.cos(midLat);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Compass point from the lake centre to a ramp. */
export function bearingFrom(aLat: number, aLon: number, bLat: number, bLon: number): string {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dy = bLat - aLat;
  const dx = (bLon - aLon) * Math.cos(midLat);
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/**
 * OSM ramps are often unnamed — Granbury's four all come back as bare
 * slipways — and the same ramp is frequently mapped twice (once as a node,
 * once as a way). A dropdown of four identical "Boat ramp" entries is useless,
 * so unnamed ramps are labelled by where they are, and near-duplicates are
 * collapsed. Exported for tests.
 */
export function labelAndDedupe(raw: Ramp[], lakeLat: number, lakeLon: number): Ramp[] {
  const kept: Ramp[] = [];
  for (const r of raw) {
    // Same name within ~150m, or any pair within ~60m, is one ramp mapped twice.
    const dup = kept.some((k) => {
      const m = milesBetween(k.lat, k.lon, r.lat, r.lon);
      return m < 0.04 || (m < 0.1 && k.name === r.name);
    });
    if (dup) continue;
    kept.push({ ...r });
  }
  return kept.map((r) => {
    if (r.named) return { name: r.name, lat: r.lat, lon: r.lon, osmRef: r.osmRef };
    const mi = milesBetween(lakeLat, lakeLon, r.lat, r.lon);
    const where = `${mi < 0.6 ? '' : mi.toFixed(1) + ' mi '}${bearingFrom(lakeLat, lakeLon, r.lat, r.lon)}`;
    return { name: `${r.name} — ${where.trim()}`, lat: r.lat, lon: r.lon, osmRef: r.osmRef };
  });
}

interface OverpassEl {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Search radius from the lake's bounding box, so a big reservoir isn't clipped. */
function radiusFor(bbox: string | null): number {
  if (!bbox) return DEFAULT_RADIUS_M;
  try {
    const [s, n, w, e] = (JSON.parse(bbox) as string[]).map(Number);
    if (![s, n, w, e].every((v) => Number.isFinite(v))) return DEFAULT_RADIUS_M;
    const midLat = ((s + n) / 2) * (Math.PI / 180);
    const heightM = Math.abs(n - s) * 111_000;
    const widthM = Math.abs(e - w) * 111_000 * Math.cos(midLat);
    // Half the longest span, plus a little, so ramps just off the polygon land.
    return Math.min(40_000, Math.max(DEFAULT_RADIUS_M, Math.round(Math.max(heightM, widthM) / 2 + 3000)));
  } catch {
    return DEFAULT_RADIUS_M;
  }
}

async function fetchFromOverpass(lat: number, lon: number, radius: number): Promise<Ramp[]> {
  const query =
    `[out:json][timeout:25];` +
    `(node["leisure"="slipway"](around:${radius},${lat},${lon});` +
    ` way["leisure"="slipway"](around:${radius},${lat},${lon});` +
    ` node["amenity"="boat_ramp"](around:${radius},${lat},${lon});` +
    ` way["amenity"="boat_ramp"](around:${radius},${lat},${lon}););` +
    `out center tags 60;`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ElavoFishAI/1.0' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as { elements?: OverpassEl[] };

  const out: Ramp[] = [];
  for (const el of json.elements || []) {
    const la = el.lat ?? el.center?.lat;
    const lo = el.lon ?? el.center?.lon;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const t = el.tags || {};
    // Unnamed ramps are common in OSM and still useful — name them by where
    // they are rather than dropping them or calling them "unnamed".
    const name = t.name || t['name:en'] || t.operator ||
      (t.access === 'private' ? 'Private ramp' : 'Boat ramp');
    out.push({
      name: t.access === 'private' && t.name ? `${name} (private)` : name,
      lat: Number(la),
      lon: Number(lo),
      osmRef: el.type && el.id ? `${el.type}/${el.id}` : undefined,
      named: !!(t.name || t['name:en'] || t.operator),
    });
  }
  // Nearest first — the ones by the lake centre are usually the main ones.
  const d2 = (r: Ramp) => (r.lat - lat) ** 2 + (r.lon - lon) ** 2;
  return labelAndDedupe(out.sort((a, b) => d2(a) - d2(b)), lat, lon).slice(0, 40);
}

/** Cached ramps for a lake. Never throws — an empty list is a fine answer. */
export async function rampsForLake(lakeId: string): Promise<{ ramps: Ramp[]; source: 'cache' | 'osm' | 'none' }> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, lat: true, lon: true, bbox: true, rampsJson: true, rampsAt: true },
  });
  if (!lake) return { ramps: [], source: 'none' };

  const fresh = lake.rampsAt && Date.now() - lake.rampsAt.getTime() < CACHE_DAYS * 86400000;
  if (fresh && lake.rampsJson) {
    try {
      return { ramps: JSON.parse(lake.rampsJson) as Ramp[], source: 'cache' };
    } catch {
      /* fall through and refetch */
    }
  }

  try {
    const ramps = await fetchFromOverpass(lake.lat, lake.lon, radiusFor(lake.bbox));
    await prisma.lake.update({
      where: { id: lake.id },
      data: { rampsJson: JSON.stringify(ramps), rampsAt: new Date() },
    });
    return { ramps, source: 'osm' };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ramps] overpass lookup failed:', (e as Error).message);
    // Serve a stale cache rather than nothing.
    if (lake.rampsJson) {
      try {
        return { ramps: JSON.parse(lake.rampsJson) as Ramp[], source: 'cache' };
      } catch { /* ignore */ }
    }
    return { ramps: [], source: 'none' };
  }
}

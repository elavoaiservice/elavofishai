/**
 * Named features on a lake — the places a fishing plan can actually point at.
 *
 * A model asked for "where to fish" will happily produce coordinates, and they
 * will be wrong: language models do not know where Rough Creek meets the lake.
 * So the planner is never allowed to invent a coordinate. It is handed a list
 * of real, named, located features from OpenStreetMap — creek mouths, points,
 * islands, bridges, dams, piers, marinas — plus the angler's own spots and the
 * ramps, and it must choose from that list. Anything it returns that is not on
 * the list is dropped before it reaches the map. See snapStops().
 *
 * Fetched once per lake and cached, the same way ramps are: Overpass is a
 * shared volunteer service and a lake's geography does not change weekly.
 */
import { prisma } from '../db';
import { milesBetween, bearingFrom } from './ramps';

export type FeatureKind = 'creek' | 'river' | 'point' | 'bay' | 'island' | 'bridge' | 'dam' | 'pier' | 'marina' | 'beach';

export interface LakeFeature {
  name: string;
  kind: FeatureKind;
  lat: number;
  lon: number;
  /** Plain-language hint about why this kind of place holds fish. */
  hint: string;
}

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const CACHE_DAYS = 45;

const HINTS: Record<FeatureKind, string> = {
  creek: 'creek mouth — inflow brings bait and cooler, oxygenated water; fish the channel where it meets the lake',
  river: 'river channel — current seam and the old riverbed; the deepest water and the travel route for fish',
  point: 'main-lake point — fish stage on the drop off the end, and wind pushes bait against it',
  bay: 'bay or pocket — protected water that warms first in spring and holds spawning fish',
  island: 'island — a hump with deep water on every side; work the windblown side',
  bridge: 'bridge pilings — shade, current when water moves, and vertical cover that holds fish year round',
  dam: 'dam — the deepest water on the lake, riprap along the face, and current when releasing',
  pier: 'fishing pier — lights, shade and bank access; a fixed spot to work depth and presentation',
  marina: 'marina — docks, shade and constant bait; fish the outside pilings and the breakwater',
  beach: 'beach or flat — shallow hard bottom; a spring spawning flat, a summer night spot',
};

interface OverpassEl { type?: string; id?: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export function kindOf(tags: Record<string, string>): FeatureKind | null {
  const nat = tags.natural || '';
  if (tags.waterway === 'stream') return 'creek';
  if (tags.waterway === 'river') return 'river';
  if (tags.waterway === 'dam') return 'dam';
  if (nat === 'cape' || nat === 'peninsula') return 'point';
  if (nat === 'bay') return 'bay';
  if (nat === 'beach') return 'beach';
  if (tags.place === 'island' || tags.place === 'islet') return 'island';
  if (tags.bridge === 'yes' || tags.man_made === 'bridge') return 'bridge';
  if (tags.man_made === 'pier') return 'pier';
  if (tags.leisure === 'marina') return 'marina';
  return null;
}

/**
 * Turn raw Overpass elements into a usable list. Exported for tests — this is
 * where the judgement lives:
 *  - a stream comes back as dozens of segments; keep the one nearest the lake
 *    centre, which on a reservoir is the mouth, not some ditch in town
 *  - a bridge over a road in town is not a fishing spot; keep bridges within
 *    the lake's own footprint (or close to the centre when no bbox is known)
 *  - unnamed things stay out, except dams and piers, which are rare enough to
 *    be worth naming by where they are
 */
export function digest(raw: OverpassEl[], lakeLat: number, lakeLon: number, bbox: [number, number, number, number] | null): LakeFeature[] {
  const inBox = (la: number, lo: number) =>
    bbox ? la >= bbox[1] - 0.01 && la <= bbox[3] + 0.01 && lo >= bbox[0] - 0.01 && lo <= bbox[2] + 0.01
         : milesBetween(lakeLat, lakeLon, la, lo) < 6;
  const best = new Map<string, LakeFeature & { d: number }>();
  for (const el of raw) {
    const t = el.tags || {};
    const kind = kindOf(t);
    if (!kind) continue;
    const la = el.lat ?? el.center?.lat;
    const lo = el.lon ?? el.center?.lon;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const lat = Number(la), lon = Number(lo);
    if (!inBox(lat, lon)) continue;
    let name = t.name || t['name:en'] || '';
    if (!name) {
      if (kind !== 'dam' && kind !== 'pier' && kind !== 'marina') continue;
      const mi = milesBetween(lakeLat, lakeLon, lat, lon);
      name = `${kind === 'dam' ? 'Dam' : kind === 'pier' ? 'Fishing pier' : 'Marina'} — ${mi.toFixed(1)} mi ${bearingFrom(lakeLat, lakeLon, lat, lon)}`;
    }
    const d = milesBetween(lakeLat, lakeLon, lat, lon);
    const key = `${kind}:${name.toLowerCase()}`;
    const cur = best.get(key);
    // Nearest segment wins: for a creek that is its mouth.
    if (!cur || d < cur.d) best.set(key, { name, kind, lat, lon, hint: HINTS[kind], d });
  }
  return [...best.values()]
    .sort((a, b) => a.d - b.d)
    .slice(0, 40)
    .map(({ d: _d, ...f }) => f);
}

function parseBbox(bbox: string | null): [number, number, number, number] | null {
  if (!bbox) return null;
  try {
    const b = (JSON.parse(bbox) as unknown[]).map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite)) return null;
    // Stored as [w,s,e,n]; a few older rows are [s,n,w,e] — detect by sign
    // (longitudes in the US are negative).
    const [a, bb, c, dd] = b;
    if (a < 0 && c < 0) return [a, bb, c, dd] as [number, number, number, number];
    return [c, a, dd, bb] as [number, number, number, number];
  } catch {
    return null;
  }
}

async function fetchFromOverpass(lat: number, lon: number, radius: number): Promise<OverpassEl[]> {
  const r = `(around:${radius},${lat},${lon})`;
  const query =
    `[out:json][timeout:25];(` +
    `node["natural"~"bay|cape|peninsula|beach"]["name"]${r};way["natural"~"bay|cape|peninsula|beach"]["name"]${r};` +
    `way["waterway"~"stream|river"]["name"]${r};` +
    `node["waterway"="dam"]${r};way["waterway"="dam"]${r};` +
    `way["bridge"="yes"]["name"]${r};` +
    `node["leisure"="marina"]${r};way["leisure"="marina"]${r};` +
    `node["man_made"="pier"]${r};way["man_made"="pier"]${r};` +
    `way["place"~"island|islet"]["name"]${r};node["place"~"island|islet"]["name"]${r};` +
    `);out center tags 300;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ElavoFishAI/1.0 (elavofishai.elavoai.com)' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return ((await res.json()) as { elements?: OverpassEl[] }).elements || [];
}

/** Cached named features for a lake. Never throws — an empty list is a fine answer. */
export async function featuresForLake(lakeId: string): Promise<LakeFeature[]> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, lat: true, lon: true, bbox: true, featuresJson: true, featuresAt: true },
  });
  if (!lake) return [];
  const fresh = lake.featuresAt && Date.now() - lake.featuresAt.getTime() < CACHE_DAYS * 86400000;
  if (fresh && lake.featuresJson) {
    try { return JSON.parse(lake.featuresJson) as LakeFeature[]; } catch { /* refetch */ }
  }
  const bbox = parseBbox(lake.bbox);
  const radius = bbox
    ? Math.min(40_000, Math.max(10_000, Math.round(Math.max((bbox[3] - bbox[1]) * 111_000, (bbox[2] - bbox[0]) * 111_000 * Math.cos((lake.lat * Math.PI) / 180)) / 2 + 2000)))
    : 12_000;
  try {
    const raw = await fetchFromOverpass(lake.lat, lake.lon, radius);
    const out = digest(raw, lake.lat, lake.lon, bbox);
    await prisma.lake.update({ where: { id: lake.id }, data: { featuresJson: JSON.stringify(out), featuresAt: new Date() } }).catch(() => {});
    return out;
  } catch {
    return lake.featuresJson ? (JSON.parse(lake.featuresJson) as LakeFeature[]) : [];
  }
}

export interface Candidate { name: string; lat: number; lon: number; kind: string; hint?: string }
export interface Stop { name: string; lat: number; lon: number; lookFor?: string; when?: string; kind?: string }

/**
 * The guard. Whatever the model returns as stops, keep only those that match a
 * candidate — by name (case-insensitive) or by being within ~150 m of one —
 * and snap the coordinates to the candidate's, so a nearly-right guess becomes
 * exactly right and an invented one disappears. Exported for tests.
 */
export function snapStops(stops: unknown, candidates: Candidate[]): Stop[] {
  if (!Array.isArray(stops)) return [];
  const out: Stop[] = [];
  for (const raw of stops.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const name = String(s.name || '').trim();
    const lat = Number(s.lat), lon = Number(s.lon);
    let match = candidates.find((c) => name && c.name.toLowerCase() === name.toLowerCase());
    if (!match && Number.isFinite(lat) && Number.isFinite(lon)) {
      match = candidates.find((c) => milesBetween(c.lat, c.lon, lat, lon) < 0.1);
    }
    if (!match) continue;
    if (out.some((o) => o.name === match!.name)) continue;
    out.push({
      name: match.name,
      lat: match.lat,
      lon: match.lon,
      kind: match.kind,
      lookFor: s.lookFor ? String(s.lookFor).slice(0, 220) : undefined,
      when: s.when ? String(s.when).slice(0, 40) : undefined,
    });
  }
  return out;
}

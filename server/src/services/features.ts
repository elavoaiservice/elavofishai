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
export function digest(raw: OverpassEl[], lakeLat: number, lakeLon: number, bbox: [number, number, number, number] | null, shore: Shoreline = []): LakeFeature[] {
  const inBox = (la: number, lo: number) =>
    bbox ? la >= bbox[1] - 0.02 && la <= bbox[3] + 0.02 && lo >= bbox[0] - 0.02 && lo <= bbox[2] + 0.02
         : milesBetween(lakeLat, lakeLon, la, lo) < 25;
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
    // With a shoreline to hand, "on the lake" is a distance, not a guess: a
    // road bridge in town is 2 km from the water and drops out here.
    if (shore.length && metresToShore(lat, lon, shore) > SHORE_M[kind]) continue;
    let name = t.name || t['name:en'] || '';
    if (!name) {
      if (kind !== 'dam' && kind !== 'pier' && kind !== 'marina') continue;
      const mi = milesBetween(lakeLat, lakeLon, lat, lon);
      name = `${kind === 'dam' ? 'Dam' : kind === 'pier' ? 'Fishing pier' : 'Marina'} — ${mi.toFixed(1)} mi ${bearingFrom(lakeLat, lakeLon, lat, lon)}`;
    }
    // Nearest segment wins: for a creek that is its mouth — nearest the water
    // when we know where the water is, nearest the centre when we do not.
    const d = shore.length ? metresToShore(lat, lon, shore) / 1609 : milesBetween(lakeLat, lakeLon, lat, lon);
    const key = `${kind}:${name.toLowerCase()}`;
    const cur = best.get(key);
    if (!cur || d < cur.d) best.set(key, { name, kind, lat, lon, hint: HINTS[kind], d });
  }
  return [...best.values()]
    .sort((a, b) => milesBetween(lakeLat, lakeLon, a.lat, a.lon) - milesBetween(lakeLat, lakeLon, b.lat, b.lon))
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

/**
 * The Overpass query.
 *
 * Asking for "bridges within 12 km of the centre" returned every road bridge
 * in the town of Granbury; what we want is "bridges that cross the lake". The
 * obvious way to ask — `around.w` on the shoreline ways — makes Overpass
 * compute geometry for every candidate against 43 long ways and times out at
 * 26 s. So the query does only what the index is good at: one bounding-box
 * sweep for candidates, and the shoreline ways with their geometry. The
 * "is it on the lake?" test is then done here, in Node, against the polylines
 * (see nearShore()), which takes milliseconds.
 *
 * The water body is found by its distinctive name (ways and multipolygon
 * relations), falling back to any lake/reservoir polygon by the centre, since
 * small lakes are often unnamed in OSM. Exported for tests.
 */
export function buildQuery(lakeName: string, lat: number, lon: number, radius: number, launch?: { lat: number; lon: number } | null): string {
  // "Lake Granbury" → "Granbury"; "Possum Kingdom Lake" → "Possum Kingdom".
  // Keep the dots in "O.H. Ivie" — they are in the OSM name too — and escape
  // them; only brackets and quotes are stripped, since they cannot be in a name.
  const token = lakeName.replace(/\b(lake|reservoir|res\.?|pool)\b/gi, '').replace(/[()\[\]{}"]/g, '').trim();
  const re = (token || lakeName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const c = launch || { lat, lon };
  const r = launch ? 15_000 : radius;
  const dLat = r / 111_000;
  const dLon = r / (111_000 * Math.cos((c.lat * Math.PI) / 180));
  const box = `(${(c.lat - dLat).toFixed(4)},${(c.lon - dLon).toFixed(4)},${(c.lat + dLat).toFixed(4)},${(c.lon + dLon).toFixed(4)})`;
  const tight = `(${(lat - 0.03).toFixed(4)},${(lon - 0.035).toFixed(4)},${(lat + 0.03).toFixed(4)},${(lon + 0.035).toFixed(4)})`;
  return (
    `[out:json][timeout:25];` +
    `(way["natural"="water"]["name"~"${re}",i]${box};rel["natural"="water"]["name"~"${re}",i]${box};)->.byname;` +
    `(way["natural"="water"]["water"~"reservoir|lake"]${tight};rel["natural"="water"]["water"~"reservoir|lake"]${tight};)->.nearby;` +
    `(.byname; .nearby;)->.water;` +
    `(way.water; way(r.water);)${launch ? `(around:15000,${launch.lat},${launch.lon})` : ''}->.shore;` +
    `(` +
    `way["waterway"~"stream|river"]["name"]${box};` +
    `way["bridge"="yes"]["name"]${box};` +
    `nwr["waterway"="dam"]${box};` +
    `nwr["man_made"="pier"]${box};` +
    `nwr["leisure"="marina"]${box};` +
    `nwr["natural"~"bay|cape|peninsula|beach"]["name"]${box};` +
    `nwr["place"~"island|islet"]["name"]${box};` +
    `)->.cand;` +
    `.cand out center tags 600;` +
    `.shore out geom;`
  );
}

export type Shoreline = Array<Array<[number, number]>>; // polylines of [lat, lon]

/** Metres from a point to the nearest shoreline segment (equirectangular). */
export function metresToShore(lat: number, lon: number, shore: Shoreline): number {
  if (!shore.length) return Infinity;
  const kx = 111_000 * Math.cos((lat * Math.PI) / 180), ky = 111_000;
  let best = Infinity;
  for (const line of shore) {
    for (let i = 1; i < line.length; i++) {
      const [aLat, aLon] = line[i - 1], [bLat, bLon] = line[i];
      const ax = (aLon - lon) * kx, ay = (aLat - lat) * ky, bx = (bLon - lon) * kx, by = (bLat - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < best) best = d;
    }
  }
  return best;
}

/** How close to the water a thing has to be to count as being on the lake. */
export const SHORE_M: Record<FeatureKind, number> = {
  creek: 150, river: 150, point: 300, bay: 300, island: 300, bridge: 40, dam: 150, pier: 80, marina: 120, beach: 200,
};

/** Split a raw Overpass response into candidates and shoreline polylines. */
export function splitResponse(raw: OverpassEl[]): { cand: OverpassEl[]; shore: Shoreline } {
  const cand: OverpassEl[] = [];
  const shore: Shoreline = [];
  for (const el of raw) {
    const geom = (el as { geometry?: Array<{ lat: number; lon: number }> }).geometry;
    if (geom && geom.length > 1 && el.tags?.natural === 'water') shore.push(geom.map((g) => [g.lat, g.lon] as [number, number]));
    else if (geom && geom.length > 1 && !el.tags) shore.push(geom.map((g) => [g.lat, g.lon] as [number, number]));
    else cand.push(el);
  }
  return { cand, shore };
}

async function fetchFromOverpass(query: string): Promise<OverpassEl[]> {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ElavoFishAI/1.0 (elavofishai.elavoai.com)' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(28_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as { elements?: OverpassEl[]; remark?: string };
  // Overpass reports a timeout as HTTP 200 with an empty list and a remark;
  // that must not be cached as "this lake has no features".
  if (json.remark && /timed out|error/i.test(json.remark) && !(json.elements || []).length) throw new Error(json.remark);
  return json.elements || [];
}

/** Big water: the whole shoreline is too much, so anchor on the launch point. */
function isBigWater(bbox: [number, number, number, number] | null): boolean {
  if (!bbox) return false;
  return (bbox[3] - bbox[1]) * 111 > 60 || (bbox[2] - bbox[0]) * 111 > 60;
}
const launchMemo = new Map<string, { at: number; features: LakeFeature[] }>();

/** Cached named features for a lake. Never throws — an empty list is a fine answer. */
export async function featuresForLake(lakeId: string, launch?: { lat?: number; lon?: number } | null): Promise<LakeFeature[]> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, name: true, lat: true, lon: true, bbox: true, featuresJson: true, featuresAt: true },
  });
  if (!lake) return [];
  const bbox = parseBbox(lake.bbox);
  const radius = bbox
    ? Math.min(60_000, Math.max(10_000, Math.round(Math.max((bbox[3] - bbox[1]) * 111_000, (bbox[2] - bbox[0]) * 111_000 * Math.cos((lake.lat * Math.PI) / 180)) / 2 + 2000)))
    : 15_000;

  // Big water with a launch point: features near where they are putting in,
  // memoised in-process rather than written to the lake row, since it differs
  // per ramp.
  const at = launch && Number.isFinite(Number(launch.lat)) && Number.isFinite(Number(launch.lon))
    ? { lat: Number(launch.lat), lon: Number(launch.lon) } : null;
  if (isBigWater(bbox) && at) {
    const key = `${lake.id}:${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
    const memo = launchMemo.get(key);
    if (memo && Date.now() - memo.at < CACHE_DAYS * 86400000) return memo.features;
    try {
      const { cand, shore } = splitResponse(await fetchFromOverpass(buildQuery(lake.name, lake.lat, lake.lon, radius, at)));
      // Ordered from the launch, not the lake centre — where the angler is.
      const out = digest(cand, at.lat, at.lon, null, shore);
      launchMemo.set(key, { at: Date.now(), features: out });
      return out;
    } catch {
      return [];
    }
  }

  const fresh = lake.featuresAt && Date.now() - lake.featuresAt.getTime() < CACHE_DAYS * 86400000;
  if (fresh && lake.featuresJson) {
    try { return JSON.parse(lake.featuresJson) as LakeFeature[]; } catch { /* refetch */ }
  }
  try {
    const { cand, shore } = splitResponse(await fetchFromOverpass(buildQuery(lake.name, lake.lat, lake.lon, radius, null)));
    const out = digest(cand, lake.lat, lake.lon, bbox, shore);
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

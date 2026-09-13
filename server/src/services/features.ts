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
  // The outline has to be closed before "in the water" means anything.
  const rings = closeRings(shore);
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
    // "On the lake" is a distance, not a guess: a road bridge in town is 2 km
    // from the water and drops out here. Without a shoreline there is no way
    // to tell, and the honest answer is to offer nothing rather than a stop
    // that might be a mile inland — the map is the part an angler acts on.
    if (!rings.length) continue;
    if (snapToShore(lat, lon, rings).m > SHORE_M[kind]) continue;
    // On the water, a boat-length off the bank — not on the bank line itself.
    const snapped = placeOnWater(lat, lon, rings);
    if (!snapped.onWater) continue;
    let name = t.name || t['name:en'] || '';
    if (!name) {
      if (kind !== 'dam' && kind !== 'pier' && kind !== 'marina') continue;
      const mi = milesBetween(lakeLat, lakeLon, snapped.lat, snapped.lon);
      name = `${kind === 'dam' ? 'Dam' : kind === 'pier' ? 'Fishing pier' : 'Marina'} — ${mi.toFixed(1)} mi ${bearingFrom(lakeLat, lakeLon, snapped.lat, snapped.lon)}`;
    }
    // How close the real thing is to the water, in miles — used only to pick
    // between two features that share a name (the creek mouth beats the same
    // creek five miles up the valley).
    const d = snapToShore(lat, lon, rings).m / 1609;
    const key = `${kind}:${name.toLowerCase()}`;
    const cur = best.get(key);
    if (!cur || d < cur.d) best.set(key, { name, kind, lat: snapped.lat, lon: snapped.lon, hint: HINTS[kind], d });
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
export function buildQuery(
  lakeName: string,
  lat: number,
  lon: number,
  radius: number,
  launch?: { lat: number; lon: number } | null,
  /**
   * Whose outline to use as "the lake".
   *
   * 'named' takes the shoreline of the water that carries this lake's name,
   * and nothing else. That matters because the candidate filter is "how far is
   * this from the water" — and when every pond, the river below the dam and
   * the neighbouring lake all contributed shoreline, a footbridge over a creek
   * and a dam on somebody else's lake both passed it, and the planner offered
   * them as stops.
   *
   * 'any' is the fallback for a lake OSM has not named, where the best we can
   * do is every water body in the box.
   */
  shoreFrom: 'named' | 'any' = 'named'
): string {
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
    `(way.${shoreFrom === 'named' ? 'byname' : 'water'}; way(r.${shoreFrom === 'named' ? 'byname' : 'water'});)${launch ? `(around:15000,${launch.lat},${launch.lon})` : ''}->.shore;` +
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

/**
 * The closest point on the lake's edge to somewhere — and how far that is.
 *
 * OSM gives a way's `center`, which is the middle of its bounding box. For a
 * creek that is somewhere up the valley; for a long bridge it is mid-span; for
 * a marina it is the car park. Those are the coordinates that were being
 * dropped on the plan's map, which is why stops looked like they were off the
 * lake — because they were. Snapping each one to the nearest point of the
 * lake's own outline puts the pin where an angler would actually fish it: the
 * creek MOUTH, the bank end of the bridge, the water's edge of the marina.
 */
export function snapToShore(
  lat: number,
  lon: number,
  shore: Shoreline
): { lat: number; lon: number; m: number } {
  if (!shore.length) return { lat, lon, m: Infinity };
  const kx = 111_000 * Math.cos((lat * Math.PI) / 180);
  const ky = 111_000;
  let best = Infinity;
  let bLatOut = lat;
  let bLonOut = lon;
  for (const line of shore) {
    for (let i = 1; i < line.length; i += 1) {
      const [aLat, aLon] = line[i - 1];
      const [bLat, bLon] = line[i];
      const ax = (aLon - lon) * kx, ay = (aLat - lat) * ky;
      const bx = (bLon - lon) * kx, by = (bLat - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < best) {
        best = d;
        bLatOut = aLat + t * (bLat - aLat);
        bLonOut = aLon + t * (bLon - aLon);
      }
    }
  }
  return { lat: bLatOut, lon: bLonOut, m: best };
}

/**
 * Stitch the open ways OSM returns into closed rings.
 *
 * A lake is usually a multipolygon relation, and its members come back as
 * separate unclosed ways — 43 of them for Lake Granbury. Joined end to end
 * they make the outline, plus a ring for each island. Without this there is no
 * inside and outside, only a line, and a point "on the shoreline" is a point
 * on the bank.
 */
export function closeRings(shore: Shoreline): Shoreline {
  const open = shore.map((l) => [...l]);
  const out: Shoreline = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let cur = open.shift() as [number, number][];
    let joined = true;
    while (joined && !same(cur[0], cur[cur.length - 1])) {
      joined = false;
      for (let i = 0; i < open.length; i += 1) {
        const l = open[i];
        if (same(l[0], cur[cur.length - 1])) { cur = cur.concat(l.slice(1)); open.splice(i, 1); joined = true; break; }
        if (same(l[l.length - 1], cur[cur.length - 1])) { cur = cur.concat([...l].reverse().slice(1)); open.splice(i, 1); joined = true; break; }
        if (same(l[l.length - 1], cur[0])) { cur = l.slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
        if (same(l[0], cur[0])) { cur = [...l].reverse().slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
      }
    }
    if (cur.length > 3 && same(cur[0], cur[cur.length - 1])) out.push(cur);
  }
  return out;
}

/**
 * Is this point in the water?
 *
 * Even-odd across every ring, so an island inside the lake counts as land and
 * a pond inside the island would count as water again.
 */
export function inWater(lat: number, lon: number, rings: Shoreline): boolean {
  let crossings = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [y1, x1] = ring[i];
      const [y2, x2] = ring[i + 1];
      if ((y1 > lat) !== (y2 > lat) && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Put the stop ON the water, and out in it rather than against the bank.
 *
 * Snapping to the nearest shoreline point was not enough, and this is the bug
 * an angler kept reporting: measured against the real Lake Granbury polygon,
 * every stop in a generated plan came back exactly 0.0 m from the edge — which
 * is the bank. On satellite imagery a pin on the bank is a pin on the land,
 * and it is not where a boat goes either.
 *
 * From the nearest edge point we try eight directions at a few distances and
 * keep whichever candidate is in the water and has the most water around it.
 * Maximising clearance rather than distance travelled is the part that
 * matters: walking the longest straight line from a bank tends to run ALONG
 * the shore, which keeps the pin against it. Clearance pushes out into the
 * channel instead, so a creek arm forty metres wide gets a pin in the middle
 * of it and open water gets one comfortably off the bank.
 *
 * Returns onWater:false when no candidate is in the water at all — the caller
 * then drops the stop rather than offering a pin on dry land.
 */
export function placeOnWater(
  lat: number,
  lon: number,
  rings: Shoreline,
  capM = 40
): { lat: number; lon: number; m: number; onWater: boolean } {
  if (!rings.length) return { lat, lon, m: Infinity, onWater: false };
  const edge = snapToShore(lat, lon, rings);
  const kx = 111_000 * Math.cos((edge.lat * Math.PI) / 180);
  const ky = 111_000;

  let best: { lat: number; lon: number; m: number } | null = null;
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    for (let d = 10; d <= capM; d += 10) {
      const la = edge.lat + (uy * d) / ky;
      const lo = edge.lon + (ux * d) / kx;
      if (!inWater(la, lo, rings)) break; // hit the far bank in this direction
      const clear = snapToShore(la, lo, rings).m;
      if (!best || clear > best.m) best = { lat: la, lon: lo, m: Math.round(clear) };
    }
  }
  return best ? { ...best, onWater: true } : { lat: edge.lat, lon: edge.lon, m: 0, onWater: false };
}

/** How close to the water a thing has to be to count as being on the lake. */
export const SHORE_M: Record<FeatureKind, number> = {
  creek: 150, river: 150, point: 300, bay: 300, island: 300, bridge: 40, dam: 150, pier: 80, marina: 120, beach: 200,
};

/**
 * Split a raw Overpass response into candidates and shoreline polylines.
 *
 * Everything with geometry is shoreline — the query decides whose shoreline
 * that is (see buildQuery's shoreFrom), which is the fix for stops landing on
 * ponds and creeks near the lake rather than on the lake.
 */
export function splitResponse(raw: OverpassEl[]): { cand: OverpassEl[]; shore: Shoreline } {
  const cand: OverpassEl[] = [];
  const shore: Shoreline = [];
  for (const el of raw) {
    const geom = (el as { geometry?: Array<{ lat: number; lon: number }> }).geometry;
    if (geom && geom.length > 1) shore.push(geom.map((g) => [g.lat, g.lon] as [number, number]));
    else cand.push(el);
  }
  return { cand, shore };
}

async function overpassOnce(query: string): Promise<OverpassEl[]> {
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

/**
 * Overpass is a free public service under constant load, and it sheds it with
 * 504s and "query timed out". One refused request used to mean a whole lake
 * fell back to whatever was cached — which, right after the stops fix, meant
 * serving the very coordinates that fix was replacing. A couple of patient
 * retries turn most of those into an answer.
 */
async function fetchFromOverpass(query: string): Promise<OverpassEl[]> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await overpassOnce(query);
    } catch (e) {
      last = e as Error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  throw last || new Error('Overpass unavailable');
}

/** Big water: the whole shoreline is too much, so anchor on the launch point. */
function isBigWater(bbox: [number, number, number, number] | null): boolean {
  if (!bbox) return false;
  return (bbox[3] - bbox[1]) * 111 > 60 || (bbox[2] - bbox[0]) * 111 > 60;
}
const launchMemo = new Map<string, { at: number; features: LakeFeature[] }>();

/**
 * Candidates plus the outline of THIS lake.
 *
 * Asks for the named water's shoreline first. Plenty of lakes are unnamed in
 * OSM, and for those the only outline available is "every water body around
 * here" — so that is the fallback, and it costs a second round trip on exactly
 * the lakes that need it.
 */
async function shorelineFor(
  name: string,
  lat: number,
  lon: number,
  radius: number,
  at: { lat: number; lon: number } | null
): Promise<{ cand: OverpassEl[]; shore: Shoreline }> {
  const first = splitResponse(await fetchFromOverpass(buildQuery(name, lat, lon, radius, at, 'named')));
  if (first.shore.length) return first;
  return splitResponse(await fetchFromOverpass(buildQuery(name, lat, lon, radius, at, 'any')));
}

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
      const { cand, shore } = await shorelineFor(lake.name, lake.lat, lake.lon, radius, at);
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
    const { cand, shore } = await shorelineFor(lake.name, lake.lat, lake.lon, radius, null);
    const out = digest(cand, lake.lat, lake.lon, bbox, shore);
    await prisma.lake.update({ where: { id: lake.id }, data: { featuresJson: JSON.stringify(out), featuresAt: new Date() } }).catch(() => {});
    return out;
  } catch {
    /* Fall back to the cache only if it was ever good.
       featuresAt is cleared whenever the stored coordinates stop being
       trustworthy — migration 0031 did exactly that after stops started being
       snapped to the shoreline. Without this check the fallback happily served
       the unsnapped coordinates the fix existed to replace, every time
       Overpass was busy, which is how a stop stayed a mile off the lake after
       the fix shipped. No stops beats wrong stops. */
    if (lake.featuresAt && lake.featuresJson) {
      try { return JSON.parse(lake.featuresJson) as LakeFeature[]; } catch { return []; }
    }
    return [];
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

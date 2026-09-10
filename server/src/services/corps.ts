/**
 * Dam releases and hydropower generation, from the Corps of Engineers.
 *
 * On a tailrace or a regulated reservoir this outranks almost everything else:
 * fish move when the water moves. USACE publishes it through the CWMS Data API
 * (cwms-data.usace.army.mil) — free, keyless, and structured.
 *
 * Two steps, both cached on the lake row because they are slow and stable:
 *   1. find the nearest CWMS project to the lake (a district's location list is
 *      ~800KB, so this is very much a once-per-lake job);
 *   2. read its outflow series — turbine flow when the project generates,
 *      total gated flow otherwise.
 *
 * Not every lake is a Corps lake. Granbury, for instance, is Brazos River
 * Authority, and BRA is a different publisher — a lake with no Corps project
 * nearby simply gets nothing here rather than a wrong number.
 */
import { prisma } from '../db';

const CWMS = 'https://cwms-data.usace.army.mil/cwms-data';
const UA = { 'User-Agent': 'ElavoFishAI/1.0', Accept: 'application/json;version=2' };
const CACHE_DAYS = 60;
const MAX_MILES = 25;

/** A location like "Table_Rock_Dam-Tainter_Gate_1" is a component of a project,
 *  not the project. Base names (no dash) are the ones worth matching — 269 of
 *  SWL's 719 locations, and the only ones that carry project-level series. */
export function isBaseLocation(name: string): boolean {
  return !!name && !name.includes('-');
}

export interface CorpsProject {
  office: string;
  name: string; // CWMS location id, e.g. WTYT2
  publicName: string;
  lat: number;
  lon: number;
  miles: number;
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dy = (bLat - aLat) * 69.0;
  const dx = (bLon - aLon) * 69.0 * Math.cos(midLat);
  return Math.sqrt(dx * dx + dy * dy);
}

interface RawLocation {
  name?: string;
  'public-name'?: string;
  latitude?: number;
  longitude?: number;
  active?: boolean;
}

async function locationsFor(office: string): Promise<CorpsProject[]> {
  const r = await fetch(`${CWMS}/locations?office=${office}`, { headers: UA, signal: AbortSignal.timeout(40_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { locations?: { locations?: RawLocation[] } } | RawLocation[];
  const raw = (Array.isArray(j) ? j : j.locations?.locations || []) as RawLocation[];
  return raw
    .filter((l) => l.active !== false && Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && isBaseLocation(String(l.name || '')))
    .map((l) => ({
      office, name: String(l.name), publicName: String(l['public-name'] || l.name),
      lat: Number(l.latitude), lon: Number(l.longitude), miles: 0,
    }));
}

/** District offices, from the Corps' own list rather than a map I typed out. */
export async function districtOffices(): Promise<string[]> {
  const r = await fetch('https://water.usace.army.mil/cda/reporting/providers?fmt=json', {
    headers: UA, signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { slug?: string; type?: string }[];
  return j.filter((p) => p.type === 'dis' && p.slug).map((p) => String(p.slug).toUpperCase());
}

/**
 * Build (or refresh) the project index. Slow and heavy on purpose — it runs
 * monthly in the background, and every lake lookup afterwards is a local
 * distance query.
 */
export async function buildIndex(): Promise<{ offices: number; projects: number }> {
  const offices = await districtOffices();
  let projects = 0;
  for (const office of offices) {
    const locs = await locationsFor(office).catch(() => []);
    for (const l of locs) {
      await prisma.corpsLocation
        .upsert({
          where: { office_name: { office: l.office, name: l.name } },
          create: { office: l.office, name: l.name, publicName: l.publicName, lat: l.lat, lon: l.lon },
          update: { publicName: l.publicName, lat: l.lat, lon: l.lon },
        })
        .then(() => { projects++; })
        .catch(() => {});
    }
  }
  return { offices: offices.length, projects };
}

/**
 * Score a location by how likely it is to be a dam that moves water.
 * Nearest-wins alone is not enough: live testing matched Granbury to
 * "GRANBURY RAWS" (a weather station 2.9 miles away) and Table Rock to a
 * dissolved-oxygen monitor below the dam. Higher is better. Exported for tests.
 */
export function damScore(name: string, publicName: string): number {
  const t = `${name} ${publicName}`.toLowerCase();
  let score = 0;
  if (/\bdam\b/.test(t)) score += 3;
  if (/\b(lake|lk|reservoir|res)\b/.test(t)) score += 2;
  if (/\bpool\b/.test(t)) score += 1;
  // Instruments, weather stations and navigation structures don't release water.
  if (/\braws\b|weather|\bmet\b/.test(t)) score -= 4;
  if (/\bdo\b|dissolved|\btemp\b|\bwq\b/.test(t)) score -= 3;
  if (/\block\b|\bharbor\b|\bmarina\b/.test(t)) score -= 2;
  if (/\btw\b|tailwater|below /.test(t)) score -= 1;
  if (/\bgage\b|\bgauge\b|\bsensor\b/.test(t)) score -= 1;
  return score;
}

/** Ranked candidates near a lake — best guess first. */
export async function findCandidates(lat: number, lon: number): Promise<CorpsProject[]> {
  if ((await prisma.corpsLocation.count()) === 0) await buildIndex().catch(() => ({ offices: 0, projects: 0 }));
  const pad = MAX_MILES / 69 + 0.05;
  const rows = await prisma.corpsLocation.findMany({
    where: { lat: { gte: lat - pad, lte: lat + pad }, lon: { gte: lon - pad * 1.4, lte: lon + pad * 1.4 } },
    take: 300,
  });
  return rows
    .map((r) => ({
      office: r.office, name: r.name, publicName: r.publicName, lat: r.lat, lon: r.lon,
      miles: milesBetween(lat, lon, r.lat, r.lon),
    }))
    .filter((r) => r.miles <= MAX_MILES)
    .sort((a, b) => {
      const d = damScore(b.name, b.publicName) - damScore(a.name, a.publicName);
      return d !== 0 ? d : a.miles - b.miles;
    })
    .slice(0, 6);
}

/** The Corps project nearest this lake, from the index. */
export async function findProject(lat: number, lon: number): Promise<CorpsProject | null> {
  if ((await prisma.corpsLocation.count()) === 0) await buildIndex().catch(() => ({ offices: 0, projects: 0 }));
  // A degree of latitude is ~69 miles; box first so the distance maths runs
  // over a handful of rows rather than every project in the country.
  const pad = MAX_MILES / 69 + 0.05;
  const rows = await prisma.corpsLocation.findMany({
    where: { lat: { gte: lat - pad, lte: lat + pad }, lon: { gte: lon - pad * 1.4, lte: lon + pad * 1.4 } },
    take: 200,
  });
  let best: CorpsProject | null = null;
  for (const r of rows) {
    const miles = milesBetween(lat, lon, r.lat, r.lon);
    if (miles <= MAX_MILES && (!best || miles < best.miles)) {
      best = { office: r.office, name: r.name, publicName: r.publicName, lat: r.lat, lon: r.lon, miles };
    }
  }
  return best;
}

export interface ReleaseReading {
  at: string; // ISO
  cfs: number;
}

export interface ReleaseSummary {
  project: string;
  office: string;
  series: string;
  units: string;
  readings: ReleaseReading[];
  generatingNow: boolean;
  latestCfs: number | null;
  peakCfs: number | null;
}

/**
 * Turn a series of outflow readings into the sentence a plan needs. Exported
 * for tests: the summary is what the model sees, so it has to be right.
 */
export function summarizeRelease(s: ReleaseSummary): string {
  if (!s.readings.length) return '';
  const last = s.readings[s.readings.length - 1];
  const when = new Date(last.at);
  const hours = s.readings.filter((r) => r.cfs > 0).length;
  const total = s.readings.length;
  const head = s.generatingNow
    ? `Water is moving now: ${Math.round(last.cfs)} ${s.units} through ${s.project} as of ${when.toISOString().slice(11, 16)}Z.`
    : `No release right now at ${s.project} (last reading ${Math.round(last.cfs)} ${s.units}).`;
  const pattern = hours === 0
    ? ' Nothing released in the last day — current will be slack.'
    : hours === total
      ? ' Running continuously for the last day.'
      : ` Released in ${hours} of the last ${total} hours — an on-and-off pattern, so time the bite to the generation.`;
  const peak = s.peakCfs ? ` Peak in that window was ${Math.round(s.peakCfs)} ${s.units}.` : '';
  return head + pattern + peak;
}

async function readSeries(office: string, name: string, hoursBack = 24): Promise<ReleaseSummary | null> {
  const begin = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const end = new Date(Date.now() + 3600_000).toISOString();
  const url = `${CWMS}/timeseries?name=${encodeURIComponent(name)}&office=${office}` +
    `&begin=${encodeURIComponent(begin)}&end=${encodeURIComponent(end)}&page-size=500`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { units?: string; values?: [number, number | null, number?][] };
  const readings: ReleaseReading[] = (j.values || [])
    .filter((v) => v[1] !== null && Number.isFinite(v[1] as number))
    .map((v) => ({ at: new Date(v[0]).toISOString(), cfs: Number(v[1]) }));
  if (!readings.length) return null;
  const latest = readings[readings.length - 1];
  return {
    project: name.split(/[.-]/)[0],
    office, series: name, units: j.units || 'cfs', readings,
    generatingNow: latest.cfs > 0,
    latestCfs: latest.cfs,
    peakCfs: Math.max(...readings.map((x) => x.cfs)),
  };
}

/**
 * Current release picture for a lake. Turbine flow first (that is generation);
 * total gated outflow as the fallback for projects without hydropower.
 */
export async function releaseFor(lakeId: string): Promise<ReleaseSummary | null> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, lat: true, lon: true, corpsProject: true, corpsAt: true },
  });
  if (!lake) return null;

  const stale = !lake.corpsAt || Date.now() - lake.corpsAt.getTime() > CACHE_DAYS * 86400000;
  // A cached project (or a cached "nothing here") is used until it goes stale.
  if (lake.corpsProject && !stale) return readAnySeries(lake.corpsProject);
  if (lake.corpsProject === '' && !stale) return null;

  // Otherwise: walk the ranked candidates and keep the first that actually
  // publishes outflow. Proximity and a promising name are guesses; a series
  // with numbers in it is the only proof that a location moves water.
  const candidates = await findCandidates(lake.lat, lake.lon).catch(() => []);
  for (const c of candidates) {
    const key = `${c.office}:${c.name}`;
    const s = await readAnySeries(key);
    if (s) {
      await prisma.lake.update({ where: { id: lake.id }, data: { corpsProject: key, corpsAt: new Date() } }).catch(() => {});
      return s;
    }
  }
  await prisma.lake.update({ where: { id: lake.id }, data: { corpsProject: '', corpsAt: new Date() } }).catch(() => {});
  return null;
}

/** Try the known outflow series shapes for one "OFFICE:LOCATION". */
async function readAnySeries(key: string): Promise<ReleaseSummary | null> {
  const [office, loc] = key.split(':');
  if (!office || !loc) return null;
  const base = loc.split('-')[0];
  // Turbine flow is generation; gated total is the whole release; the daily
  // averages are the fallback for projects that don't publish hourly.
  for (const series of [
    `${base}-Turbine.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
    `${base}-Gated_Total.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
    `${base}.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
    `${base}-Turbine.Flow-Out.Ave.~1Day.1Day.Rev-${office}-REGI`,
    `${base}-Gated_Total.Flow-Out.Ave.~1Day.1Day.Rev-${office}-REGI`,
  ]) {
    const s = await readSeries(office, series).catch(() => null);
    if (s) return s;
  }
  return null;
}

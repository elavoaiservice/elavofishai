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

/**
 * State → the USACE district offices that operate water there. Not exhaustive
 * — it covers the districts with the reservoirs people fish, and an unknown
 * state simply means no Corps lookup rather than a wrong one.
 */
const STATE_DISTRICTS: Record<string, string[]> = {
  Texas: ['SWF', 'SWG', 'SWT'], Oklahoma: ['SWT'], Arkansas: ['SWL', 'MVK'],
  Missouri: ['NWK', 'MVS', 'LRL'], Kansas: ['NWK'], Nebraska: ['NWO'],
  Iowa: ['MVR', 'NWO'], Illinois: ['MVR', 'MVS', 'LRL'], Kentucky: ['LRL', 'LRN'],
  Tennessee: ['LRN'], Alabama: ['SAM'], Georgia: ['SAM', 'SAS'], Florida: ['SAJ'],
  Mississippi: ['MVK'], Louisiana: ['MVN', 'MVK'], Virginia: ['NAO', 'LRH'],
  'West Virginia': ['LRH', 'LRP'], Ohio: ['LRH', 'LRB', 'LRL'], Pennsylvania: ['LRP', 'NAB'],
  'New York': ['LRB', 'NAN'], Michigan: ['LRE'], Wisconsin: ['MVP', 'LRE'],
  Minnesota: ['MVP'], 'North Dakota': ['NWO'], 'South Dakota': ['NWO'],
  Montana: ['NWO', 'NWS'], Washington: ['NWS', 'NWW'], Oregon: ['NWP', 'NWW'],
  Idaho: ['NWW'], California: ['SPK', 'SPL'], Nevada: ['SPK'], Arizona: ['SPL'],
  'New Mexico': ['SPA'], Colorado: ['NWO', 'SPA'], 'North Carolina': ['SAW'],
  'South Carolina': ['SAC'], Kentucky_TN: ['LRN'], Indiana: ['LRL'],
};

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

/** Districts worth searching for a lake in this region. Exported for tests. */
export function districtsFor(region: string | null): string[] {
  if (!region) return [];
  const hit = Object.keys(STATE_DISTRICTS).find((state) =>
    region.toLowerCase().includes(state.toLowerCase().replace('_', ' '))
  );
  return hit ? STATE_DISTRICTS[hit] : [];
}

async function locationsFor(office: string): Promise<CorpsProject[]> {
  const r = await fetch(`${CWMS}/locations?office=${office}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { locations?: { locations?: unknown[] } } | unknown[];
  const raw = (Array.isArray(j) ? j : j.locations?.locations || []) as {
    name?: string; 'public-name'?: string; latitude?: number; longitude?: number; active?: boolean;
  }[];
  return raw
    .filter((l) => l.active !== false && Number.isFinite(l.latitude) && Number.isFinite(l.longitude))
    .map((l) => ({
      office, name: String(l.name), publicName: String(l['public-name'] || l.name),
      lat: Number(l.latitude), lon: Number(l.longitude), miles: 0,
    }));
}

/** The Corps project nearest this lake, if there is one worth using. */
export async function findProject(lat: number, lon: number, region: string | null): Promise<CorpsProject | null> {
  const offices = districtsFor(region);
  let best: CorpsProject | null = null;
  for (const office of offices) {
    const locs = await locationsFor(office).catch(() => []);
    for (const l of locs) {
      const miles = milesBetween(lat, lon, l.lat, l.lon);
      // Prefer something that reads like the lake itself, not a stream gauge.
      if (miles <= MAX_MILES && (!best || miles < best.miles)) best = { ...l, miles };
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
    select: { id: true, lat: true, lon: true, region: true, corpsProject: true, corpsAt: true },
  });
  if (!lake) return null;

  let project = lake.corpsProject;
  const stale = !lake.corpsAt || Date.now() - lake.corpsAt.getTime() > CACHE_DAYS * 86400000;
  if (!project && stale) {
    const found = await findProject(lake.lat, lake.lon, lake.region).catch(() => null);
    project = found ? `${found.office}:${found.name}` : '';
    await prisma.lake.update({
      where: { id: lake.id },
      data: { corpsProject: project, corpsAt: new Date() },
    }).catch(() => {});
  }
  if (!project) return null;

  const [office, loc] = project.split(':');
  if (!office || !loc) return null;
  const base = loc.split('-')[0];
  for (const series of [
    `${base}-Turbine.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
    `${base}-Gated_Total.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
    `${base}.Flow-Out.Inst.1Hour.0.Rev-${office}-REGI`,
  ]) {
    const s = await readSeries(office, series).catch(() => null);
    if (s) return s;
  }
  return null;
}

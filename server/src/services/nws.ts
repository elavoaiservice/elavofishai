/**
 * The National Weather Service, for the two things it does that a forecast
 * API cannot: it tells you when not to go, and it tells you why.
 *
 * An active Lake Wind Advisory is not a scoring input to be weighed against
 * cloud cover — it is a reason to stay off the water — so alerts are shown
 * above everything else and handed to the planner as a hard constraint. The
 * Area Forecast Discussion is the local forecaster's own reasoning ("a stalled
 * boundary near I-20 will fire storms after 3pm"), which is exactly the sort
 * of detail that decides whether a morning is fishable.
 */
const UA = 'ElavoFishAI/1.0 (https://elavofishai.elavoai.com)';

export interface Alert {
  event: string;
  severity: string;
  headline: string;
  onset: string | null;
  ends: string | null;
}
export interface Discussion {
  office: string;
  issued: string;
  text: string;
}

export function parseAlerts(json: unknown): Alert[] {
  const feats = ((json as { features?: { properties?: Record<string, unknown> }[] })?.features || []);
  return feats
    .map((f) => f.properties || {})
    .filter((p) => p.event)
    .map((p) => ({
      event: String(p.event),
      severity: String(p.severity || 'Unknown'),
      headline: String(p.headline || '').slice(0, 200),
      onset: p.onset ? String(p.onset) : null,
      ends: p.ends ? String(p.ends) : null,
    }))
    .slice(0, 6);
}

/**
 * Pull the near-term reasoning out of an Area Forecast Discussion. The product
 * is plain text with sections marked `.SHORT TERM...`; we want the first one
 * that talks about the next day or two, not the aviation or climate sections.
 */
export function shortTermOf(text: string, max = 900): string {
  const clean = String(text || '').replace(/\r/g, '');
  const wanted = ['SHORT TERM', 'NEAR TERM', 'TODAY', 'KEY MESSAGES', 'DISCUSSION'];
  for (const name of wanted) {
    const start = clean.indexOf(`.${name}`);
    if (start < 0) continue;
    const after = clean.slice(start);
    // Sections end at the next `.SECTION NAME...` header, or at the && marker.
    const end = after.slice(1).search(/\n\s*\.[A-Z][A-Z /&-]{3,40}\.\.\.|\n\s*&&/);
    const body = (end > 0 ? after.slice(0, end + 1) : after)
      .replace(/^\.[A-Z][A-Z /&-]{3,40}\.\.\.\s*/, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body.length > 40) return body.length > max ? `${body.slice(0, max - 1)}…` : body;
  }
  return '';
}

/**
 * The raw forecast grid — the numbers Open-Meteo does not carry.
 *
 * Three of them decide whether a morning is fishable and none were available
 * before: how likely thunder is, how hard it will gust (a 12 mph average with
 * 30 mph gusts is a different day from a steady 12), and how much cloud.
 *
 * NWS publishes these as time INTERVALS — "from 05:00Z for 1 day 19 hours,
 * the value is 0" — rather than one reading per hour, so a value has to be
 * spread across the hours it covers before it can be read off. Exported for
 * tests, because that expansion is where this would quietly go wrong.
 */
export function durationHours(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso || '');
  if (!m) return 1;
  const [, d, h, min] = m;
  const hours = (Number(d || 0) * 24) + Number(h || 0) + (Number(min || 0) >= 30 ? 1 : 0);
  return Math.max(1, hours);
}

export interface GridSeries { values?: { validTime?: string; value?: number | null }[] }

/** Hour (ISO, to the hour, UTC) → value, for the next `hours` hours. */
export function expandSeries(series: GridSeries | undefined, fromMs: number, hours = 48): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of series?.values || []) {
    const [start, dur] = String(v.validTime || '').split('/');
    const t0 = Date.parse(start);
    if (!Number.isFinite(t0) || v.value === null || v.value === undefined) continue;
    const span = durationHours(dur);
    for (let i = 0; i < span; i++) {
      const at = t0 + i * 3600_000;
      if (at < fromMs - 3600_000 || at > fromMs + hours * 3600_000) continue;
      out.set(new Date(at).toISOString().slice(0, 13), Number(v.value));
    }
  }
  return out;
}

const kmhToMph = (v: number) => Math.round(v * 0.621371);

export interface Outlook {
  thunderPct: number | null;
  gustMph: number | null;
  skyPct: number | null;
  rainPct: number | null;
  hours: { at: string; thunderPct: number | null; gustMph: number | null }[];
}

/** Read one day's worth of the grid, starting now. */
export function readGrid(props: Record<string, GridSeries | undefined> | null, fromMs: number): Outlook | null {
  if (!props) return null;
  const thunder = expandSeries(props.probabilityOfThunder, fromMs);
  const gust = expandSeries(props.windGust, fromMs);
  const sky = expandSeries(props.skyCover, fromMs);
  const rain = expandSeries(props.probabilityOfPrecipitation, fromMs);
  const keys = [...new Set([...thunder.keys(), ...gust.keys()])].sort().slice(0, 24);
  const peak = (m: Map<string, number>) => {
    const vals = keys.map((k) => m.get(k)).filter((v): v is number => v !== undefined);
    return vals.length ? Math.max(...vals) : null;
  };
  const g = peak(gust);
  return {
    thunderPct: peak(thunder),
    gustMph: g === null ? null : kmhToMph(g),
    skyPct: peak(sky),
    rainPct: peak(rain),
    hours: keys.map((k) => ({
      at: `${k}:00:00Z`,
      thunderPct: thunder.get(k) ?? null,
      gustMph: gust.has(k) ? kmhToMph(gust.get(k) as number) : null,
    })),
  };
}

async function get(url: string, json: boolean, ms = 10_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/geo+json' : 'text/plain' }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return json ? await res.json() : await res.text();
  } catch {
    return null;
  }
}

// Alerts change on the hour at best; the office for a point never changes.
const alertCache = new Map<string, { at: number; value: Alert[] }>();
const officeCache = new Map<string, string>();
const afdCache = new Map<string, { at: number; value: Discussion | null }>();
const key = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export async function alertsFor(lat: number, lon: number): Promise<Alert[]> {
  const k = key(lat, lon);
  const hit = alertCache.get(k);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.value;
  const json = await get(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, true);
  const value = json ? parseAlerts(json) : hit?.value || [];
  alertCache.set(k, { at: Date.now(), value });
  return value;
}

// The grid product is ~290 KB and changes hourly, so it is fetched once per
// cell per hour, not once per page view.
const gridCache = new Map<string, { at: number; value: Outlook | null }>();

export async function outlookFor(lat: number, lon: number): Promise<Outlook | null> {
  const k = key(lat, lon);
  const hit = gridCache.get(k);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;
  const office = await officeFor(lat, lon);
  if (!office) return null;
  const grid = (await get(`https://api.weather.gov/gridpoints/${office.id}/${office.x},${office.y}`, true, 20_000)) as
    | { properties?: Record<string, GridSeries | undefined> }
    | null;
  const value = readGrid(grid?.properties || null, Date.now());
  gridCache.set(k, { at: Date.now(), value });
  return value;
}

/** The forecast office and grid cell covering a point. Fixed for a location. */
const officeCells = new Map<string, { id: string; x: number; y: number }>();
async function officeFor(lat: number, lon: number): Promise<{ id: string; x: number; y: number } | null> {
  const k = key(lat, lon);
  const hit = officeCells.get(k);
  if (hit) return hit;
  const pt = (await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, true)) as
    | { properties?: { gridId?: string; gridX?: number; gridY?: number } }
    | null;
  const p = pt?.properties;
  if (!p?.gridId || p.gridX === undefined || p.gridY === undefined) return null;
  const cell = { id: String(p.gridId), x: Number(p.gridX), y: Number(p.gridY) };
  officeCells.set(k, cell);
  officeCache.set(k, cell.id);
  return cell;
}

export async function discussionFor(lat: number, lon: number): Promise<Discussion | null> {
  const k = key(lat, lon);
  const hit = afdCache.get(k);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;

  const office = officeCache.get(k) || (await officeFor(lat, lon))?.id || '';
  if (!office) return null;

  const prod = (await get(`https://api.weather.gov/products/types/AFD/locations/${office}/latest`, true)) as
    | { issuanceTime?: string; productText?: string }
    | null;
  const text = shortTermOf(prod?.productText || '');
  const value = text ? { office, issued: String(prod?.issuanceTime || ''), text } : null;
  afdCache.set(k, { at: Date.now(), value });
  return value;
}

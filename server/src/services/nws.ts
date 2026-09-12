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

export async function discussionFor(lat: number, lon: number): Promise<Discussion | null> {
  const k = key(lat, lon);
  const hit = afdCache.get(k);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;

  let office = officeCache.get(k) || '';
  if (!office) {
    const pt = (await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, true)) as { properties?: { gridId?: string } } | null;
    office = String(pt?.properties?.gridId || '');
    if (office) officeCache.set(k, office);
  }
  if (!office) return null;

  const prod = (await get(`https://api.weather.gov/products/types/AFD/locations/${office}/latest`, true)) as
    | { issuanceTime?: string; productText?: string }
    | null;
  const text = shortTermOf(prod?.productText || '');
  const value = text ? { office, issued: String(prod?.issuanceTime || ''), text } : null;
  afdCache.set(k, { at: Date.now(), value });
  return value;
}

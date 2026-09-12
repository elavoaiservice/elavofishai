/**
 * What you may keep.
 *
 * Getting a limit wrong is the one mistake this app could cause that costs an
 * angler money and a court date, so the rules are treated differently from
 * everything else here: they are quoted from the agency, dated, attributed,
 * and linked — never summarised by a model, and never guessed.
 *
 * Texas publishes an index of every water with an exception, and a page per
 * water. A lake that is NOT on that index is not missing data: it means the
 * statewide limits apply, which is a definite and useful answer.
 */
import { prisma } from '../db';
import { fetchText } from './reports';

const INDEX_URL =
  'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/freshwater-fishing/freshwater-fishing-laws-and-exceptions/';
const STATEWIDE_URL =
  'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/freshwater-fishing/statewide-freshwater-fishing-regulations/';
const CACHE_DAYS = 30;

export interface Rule { species: string; text: string }
export interface Regulations {
  scope: 'exception' | 'statewide';
  water: string | null;
  rules: Rule[];
  advisory: string | null;
  url: string;
  statewideUrl: string;
  checkedAt: string;
}

/** Every named water with its own rules, from the index page. */
export function parseIndex(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]*fishregs2\.php\?water=[^"]+)"[^>]*>([\s\S]{1,120}?)<\/a>/gi)) {
    const name = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (name) out.push({ name, url: m[1].replace(/&amp;/g, '&') });
  }
  return out;
}

/**
 * The rules on one water's page: a species heading and the sentences under it.
 * Quoted, not interpreted — an angler and a game warden should be reading the
 * same words.
 */
export function parseWaterPage(html: string): { rules: Rule[]; advisory: string | null } {
  const src = String(html || '');
  const rules: Rule[] = [];
  for (const m of src.matchAll(/<dt[^>]*>([\s\S]{1,120}?)<\/dt>\s*<dd[^>]*>([\s\S]{1,2000}?)<\/dd>/gi)) {
    const species = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
    if (species && text.length > 5) rules.push({ species, text: text.slice(0, 600) });
  }
  const adv = /consumption advisory[^.]{0,160}\./i.exec(src.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  return { rules, advisory: adv ? adv[0].trim() : null };
}

/** "Lake Fork" matches "Fork"; "Belton" must not match "Bellwood". */
export function matchWater(index: { name: string; url: string }[], lakeName: string): { name: string; url: string } | null {
  const key = (s: string) =>
    s.toLowerCase().replace(/\b(lake|reservoir|res|state park|sp)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = key(lakeName);
  if (want.length < 3) return null;
  // Exact on the normalised name only. A "contains" match put Belton under
  // Bellwood, and a wrong limit is worse than no limit.
  return index.find((e) => key(e.name) === want)
    // A parenthesised county — "Belton (Bell County)" — is still that lake.
    || index.find((e) => key(e.name.replace(/\([^)]*\)/g, '')) === want)
    || null;
}

/** The rules for a lake, cached for a month. Null when we have no source. */
export async function regulationsFor(lakeId: string): Promise<Regulations | null> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, name: true, region: true, country: true, regsJson: true, regsAt: true },
  });
  if (!lake) return null;
  const fresh = lake.regsAt && Date.now() - lake.regsAt.getTime() < CACHE_DAYS * 86400000;
  if (fresh && lake.regsJson) {
    try { return JSON.parse(lake.regsJson) as Regulations; } catch { /* refetch */ }
  }
  // Only Texas for now. Saying nothing is the honest answer elsewhere; a
  // Texas bag limit shown on a Michigan lake would be worse than a blank.
  if (!/\btexas\b|\bTX\b/i.test(lake.region || '')) return null;

  try {
    const index = parseIndex(await fetchText(INDEX_URL));
    if (!index.length) return null;
    const hit = matchWater(index, lake.name);
    let regs: Regulations;
    if (!hit) {
      regs = {
        scope: 'statewide',
        water: null,
        rules: [],
        advisory: null,
        url: INDEX_URL,
        statewideUrl: STATEWIDE_URL,
        checkedAt: new Date().toISOString(),
      };
    } else {
      const { rules, advisory } = parseWaterPage(await fetchText(hit.url));
      regs = {
        scope: 'exception',
        water: hit.name,
        rules,
        advisory,
        url: hit.url,
        statewideUrl: STATEWIDE_URL,
        checkedAt: new Date().toISOString(),
      };
    }
    await prisma.lake.update({ where: { id: lake.id }, data: { regsJson: JSON.stringify(regs), regsAt: new Date() } }).catch(() => {});
    return regs;
  } catch {
    return lake.regsJson ? (JSON.parse(lake.regsJson) as Regulations) : null;
  }
}

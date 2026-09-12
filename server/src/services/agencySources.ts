/**
 * Official per-lake pages, attached automatically when a lake is added.
 *
 * Texas is first because TPWD publishes a page per public lake at a
 * predictable URL, and those pages carry the species, records, regulations and
 * habitat notes for that specific water. Other states will need their own
 * resolver — the shape here is deliberately per-state, because the URL patterns
 * have nothing in common and pretending otherwise produces confident 404s.
 */
import { prisma } from '../db';
import { fetchText, htmlToText, looksLikeSoft404 } from './reports';

const UA = { 'User-Agent': 'ElavoFishAI/1.0 (+https://elavofishai.elavoai.com)' };

/**
 * TPWD slugs are the lake name with the noise removed: "Lake Granbury" →
 * granbury, "Cedar Creek Reservoir" → cedarcreek, "O.H. Ivie" → ohivie.
 * Several candidates because the pattern isn't perfectly consistent.
 * Exported for tests.
 */
export function tpwdSlugCandidates(name: string): string[] {
  const core = name
    .replace(/^lake\s+/i, '')
    .replace(/\s+(lake|reservoir)$/i, '')
    .trim();
  const compact = core.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hyphen = core.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const full = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  // A slug that is just a generic word would fetch a directory page, not a
  // lake — and the directory page might even mention the lake name in a list.
  const GENERIC = new Set(['lake', 'lakes', 'reservoir', 'pond', 'river', 'creek', 'water']);
  return [...new Set([compact, hyphen, full].filter((s) => s.length >= 3 && !GENERIC.has(s)))];
}

export const tpwdUrl = (slug: string) => `https://tpwd.texas.gov/fishboat/fish/recreational/lakes/${slug}/`;

/** Is this a Texas lake? Region strings vary ("Texas", "Hood County, Texas"). */
export function isTexas(region: string | null, country: string | null): boolean {
  if (country && !/^(us|usa|united states)$/i.test(country)) return false;
  return !!region && /\btexas\b|\btx\b/i.test(region);
}

/**
 * Find the official page for a lake and attach it as a report source. Verifies
 * before saving: the page must load, not be a soft 404, and actually name the
 * lake — a URL that merely resolves is not evidence of anything.
 */
export async function attachOfficialSource(lakeId: string): Promise<{ added: boolean; url?: string; why?: string }> {
  const lake = await prisma.lake.findUnique({
    where: { id: lakeId },
    select: { id: true, name: true, region: true, country: true },
  });
  if (!lake) return { added: false, why: 'no such lake' };
  if (!isTexas(lake.region, lake.country)) return { added: false, why: 'no per-lake resolver for this state yet' };

  const existing = await prisma.reportSource.findFirst({
    where: { lakeId: lake.id, url: { contains: 'tpwd.texas.gov' } },
  });
  if (existing) return { added: false, why: 'already attached' };

  const core = lake.name.replace(/^lake\s+/i, '').replace(/\s+(lake|reservoir)$/i, '').toLowerCase();
  for (const slug of tpwdSlugCandidates(lake.name)) {
    const url = tpwdUrl(slug);
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const text = htmlToText(await res.text());
      if (looksLikeSoft404(text)) continue;
      // The page has to be about THIS lake, not a directory that happens to load.
      if (!text.toLowerCase().includes(core)) continue;

      await prisma.reportSource.create({
        data: {
          name: `TPWD — ${lake.name}`,
          url,
          kind: 'html',
          lakeId: lake.id,
        },
      });
      return { added: true, url };
    } catch {
      /* try the next candidate slug */
    }
  }
  return { added: false, why: 'no official page found for this lake' };
}

/** Attach official pages to every lake that doesn't have one. */
/**
 * What a lake has been stocked with, from TPWD.
 *
 * The stocking table is the most concrete thing an agency publishes about a
 * lake: 100,399 striped bass fingerlings in 2026 tells you what will be
 * catchable next year, and a species that stopped being stocked tells you
 * something too. The water-body code lives on the lake's own TPWD page (which
 * we already resolve), and the stocking page states which lake it is in its
 * title — so a wrong code is caught rather than filed under the wrong water.
 */
export function wbCodeFrom(html: string): string | null {
  const m = /WB_code=([0-9A-Za-z]{2,8})/.exec(String(html || ''));
  return m ? m[1] : null;
}

export interface StockingRow { species: string; year: number; number: number; size: string }

export function parseStocking(html: string): { lake: string | null; rows: StockingRow[] } {
  const src = String(html || '');
  const title = /<title>\s*Stocking Report for ([^<]{2,60})</i.exec(src);
  const rows: StockingRow[] = [];
  for (const tr of src.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const year = Number(cells[1]);
    const number = Number(String(cells[2]).replace(/,/g, ''));
    if (!Number.isInteger(year) || year < 1970 || year > 2100 || !Number.isFinite(number)) continue;
    rows.push({ species: cells[0], year, number, size: cells[3] });
  }
  return { lake: title ? title[1].trim() : null, rows };
}

/** The last few years, as a sentence a guide would actually say. */
export function stockingSummary(rows: StockingRow[], years = 5, now = new Date()): string {
  const cutoff = now.getFullYear() - years;
  const recent = rows.filter((r) => r.year >= cutoff).sort((a, b) => b.year - a.year || b.number - a.number);
  if (!recent.length) return '';
  const lines = recent.slice(0, 12).map((r) => `${r.year}: ${r.species} ×${r.number.toLocaleString('en-US')} (${r.size.toLowerCase()})`);
  return `Stocked by TPWD — ${lines.join('; ')}.`;
}

/**
 * Fetch and store one lake's stocking history as a report. Undated on purpose:
 * it is a standing fact about the lake, not this week's news, and the years
 * are in the text where they belong.
 */
export async function attachStocking(lakeId: string): Promise<boolean> {
  const lake = await prisma.lake.findUnique({ where: { id: lakeId }, select: { id: true, name: true, region: true, country: true } });
  if (!lake || !isTexas(lake.region, lake.country)) return false;

  let code: string | null = null;
  for (const slug of tpwdSlugCandidates(lake.name)) {
    const page = await fetchText(tpwdUrl(slug)).catch(() => '');
    code = wbCodeFrom(page);
    if (code) break;
  }
  if (!code) return false;

  const url = `https://tpwd.texas.gov/fishboat/fish/action/stock_bywater.php?WB_code=${code}`;
  const html = await fetchText(url).catch(() => '');
  const { lake: named, rows } = parseStocking(html);
  // The page says which lake it is. If that does not look like our lake, the
  // code was wrong and filing it here would be worse than having nothing.
  const key = (x: string) => x.toLowerCase().replace(/\b(lake|reservoir|res)\b/g, '').replace(/[^a-z]/g, '');
  if (!named || !key(lake.name).includes(key(named))) return false;
  const body = stockingSummary(rows);
  if (!body) return false;

  await prisma.lakeReport.upsert({
    where: { lakeId_url: { lakeId: lake.id, url } },
    create: { lakeId: lake.id, source: 'stocking', sourceName: 'TPWD stocking history', title: 'Stocking history', body, url, publishedAt: null },
    update: { body },
  });
  return true;
}

export async function attachOfficialSourcesForAll(): Promise<{ checked: number; added: number; stocked: number; urls: string[] }> {
  const lakes = await prisma.lake.findMany({ select: { id: true } });
  const urls: string[] = [];
  let added = 0;
  let stocked = 0;
  for (const l of lakes) {
    const r = await attachOfficialSource(l.id).catch(() => ({ added: false, url: undefined }));
    if (r.added && r.url) { added++; urls.push(r.url); }
    // Stocking history is a separate, more concrete thing than the lake page.
    if (await attachStocking(l.id).catch(() => false)) stocked += 1;
  }
  return { checked: lakes.length, added, stocked, urls };
}

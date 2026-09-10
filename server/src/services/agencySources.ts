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
import { htmlToText, looksLikeSoft404 } from './reports';

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
export async function attachOfficialSourcesForAll(): Promise<{ checked: number; added: number; urls: string[] }> {
  const lakes = await prisma.lake.findMany({ select: { id: true } });
  const urls: string[] = [];
  let added = 0;
  for (const l of lakes) {
    const r = await attachOfficialSource(l.id).catch(() => ({ added: false, url: undefined }));
    if (r.added && r.url) { added++; urls.push(r.url); }
  }
  return { checked: lakes.length, added, urls };
}

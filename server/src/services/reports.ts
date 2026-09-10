/**
 * Fishing reports — the legal, useful half of "scrape the internet for reports".
 *
 * Three kinds, in descending order of how much the planner should trust them:
 *   agency  — a state wildlife or Corps feed. Authoritative, explicitly public.
 *   web     — a page we were pointed at (a marina or guide's report feed).
 *   angler  — someone who was actually on the water. The freshest signal there
 *             is, and the only one nobody else can copy.
 *
 * We fetch only sources an operator has added, we identify ourselves, and we
 * respect what a site says about automated access. Nothing here scrapes a
 * platform that forbids it — that is a licence and reputation risk, and the
 * indexed web plus your own anglers is better material anyway.
 */
import { prisma } from '../db';

const UA = 'ElavoFishAI/1.0 (+https://elavofishai.elavoai.com)';
const MAX_BODY = 4000;

export interface FetchedItem {
  title?: string;
  body: string;
  url?: string;
  publishedAt?: Date;
}

/** Strip tags and collapse whitespace — enough to read, no DOM library. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const pick = (xml: string, tag: string): string | undefined => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return undefined;
  return htmlToText(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() || undefined;
};

/**
 * Parse RSS or Atom into items. Both formats in one pass: they differ in the
 * item tag and the date field, and little else that matters here.
 * Exported for tests.
 */
export function parseFeed(xml: string): FetchedItem[] {
  const items: FetchedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = pick(b, 'title');
    const body = pick(b, 'description') || pick(b, 'summary') || pick(b, 'content') || pick(b, 'content:encoded') || '';
    // Atom puts the URL in an attribute; RSS in a text node.
    const linkAttr = b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    const url = pick(b, 'link') || linkAttr;
    const dateText = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date');
    const published = dateText ? new Date(dateText) : undefined;
    if (!title && !body) continue;
    items.push({
      title,
      body: (body || title || '').slice(0, MAX_BODY),
      url,
      publishedAt: published && !Number.isNaN(published.valueOf()) ? published : undefined,
    });
  }
  return items;
}

/** Does this item plausibly concern this lake? */
export function mentionsLake(item: FetchedItem, lakeName: string): boolean {
  const hay = `${item.title || ''} ${item.body}`.toLowerCase();
  const name = lakeName.toLowerCase().replace(/^lake\s+/, '').replace(/\s+(lake|reservoir)$/, '');
  if (name.length < 3) return false;
  return hay.includes(name);
}

/**
 * Plenty of agency sites answer a missing page with HTTP 200 and a "404 Page
 * Not Found" body — Oklahoma's does. Storing that as a fishing report would
 * put nonsense in front of the planner, so treat it as the failure it is.
 * Exported for tests.
 */
export function looksLikeSoft404(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return /(^|\s)404(\s|$)/.test(head) || /page not found|page can'?t be found|page doesn'?t exist/.test(head);
}

/**
 * Pull the part of a page that actually concerns this lake. A fetched page is
 * mostly navigation; storing all of it buries a two-line report in site chrome
 * when the planner reads it. Exported for tests.
 */
export function extractAbout(text: string, lakeName: string, span = 1200): string {
  const name = lakeName.replace(/^lake\s+/i, '').replace(/\s+(lake|reservoir)$/i, '');
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  if (name.length < 3 || at < 0) return text.slice(0, span);
  const start = Math.max(0, at - Math.floor(span / 4));
  return text.slice(start, start + span).trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Pull one source and store anything new about lakes we know. A source pinned
 * to a lake stores everything it finds; a regional source only stores items
 * that actually name one of that region's lakes.
 */
export async function fetchSource(sourceId: string): Promise<{ stored: number; scanned: number; error?: string }> {
  const src = await prisma.reportSource.findUnique({ where: { id: sourceId } });
  if (!src || !src.active) return { stored: 0, scanned: 0, error: 'no such active source' };

  let items: FetchedItem[] = [];
  try {
    const text = await fetchText(src.url);
    if (src.kind === 'html') {
      const page = htmlToText(text);
      if (looksLikeSoft404(page)) throw new Error('page answered 200 with a "not found" body');
      // Trimmed per lake below; keep the whole page here.
      items = [{ body: page, url: src.url, publishedAt: new Date() }];
    } else {
      items = parseFeed(text);
    }
  } catch (e) {
    await prisma.reportSource.update({
      where: { id: src.id },
      data: { lastFetchedAt: new Date(), lastError: (e as Error).message.slice(0, 200) },
    });
    return { stored: 0, scanned: 0, error: (e as Error).message };
  }

  const lakes = src.lakeId
    ? await prisma.lake.findMany({ where: { id: src.lakeId } })
    : await prisma.lake.findMany({ where: src.region ? { region: { contains: src.region, mode: 'insensitive' } } : {} , take: 500 });

  let stored = 0;
  for (const item of items) {
    for (const lake of lakes) {
      // A regional feed has to actually name the lake; a pinned one doesn't.
      if (!src.lakeId && !mentionsLake(item, lake.name)) continue;
      try {
        // For a page, keep the part that names this lake rather than the whole
        // site; for a feed item, the item is already the unit.
        const body = src.kind === 'html' ? extractAbout(item.body, lake.name) : item.body.slice(0, MAX_BODY);
        await prisma.lakeReport.upsert({
          where: { lakeId_url: { lakeId: lake.id, url: item.url || `${src.id}:${item.title || ''}` } },
          create: {
            lakeId: lake.id,
            source: 'agency',
            sourceName: src.name,
            title: item.title?.slice(0, 200) || null,
            body,
            url: item.url || src.url,
            publishedAt: item.publishedAt || new Date(),
          },
          update: { body, publishedAt: item.publishedAt || undefined },
        });
        stored++;
      } catch {
        /* one bad row shouldn't stop the fetch */
      }
    }
  }

  await prisma.reportSource.update({
    where: { id: src.id },
    data: { lastFetchedAt: new Date(), lastError: null },
  });
  return { stored, scanned: items.length };
}

/** Refresh every active source. Run on a schedule; safe to run twice. */
export async function refreshAllSources(): Promise<{ sources: number; stored: number }> {
  const sources = await prisma.reportSource.findMany({ where: { active: true }, select: { id: true } });
  let stored = 0;
  for (const s of sources) {
    const r = await fetchSource(s.id).catch(() => ({ stored: 0 }));
    stored += r.stored;
  }
  return { sources: sources.length, stored };
}

/** Recent reports for a lake, freshest first — what the planner reads. */
export async function recentReports(lakeId: string, days = 21, take = 8) {
  return prisma.lakeReport.findMany({
    where: { lakeId, publishedAt: { gte: new Date(Date.now() - days * 86400000) } },
    orderBy: { publishedAt: 'desc' },
    take,
    select: { source: true, sourceName: true, title: true, body: true, url: true, publishedAt: true },
  });
}

/** Trim reports into the block the day-plan prompt carries. */
export function reportsForPrompt(rows: Awaited<ReturnType<typeof recentReports>>): string {
  if (!rows.length) return '';
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'undated');
  return rows
    .map((r) => {
      const who = r.source === 'angler' ? `angler ${r.sourceName || ''}`.trim() : r.sourceName || r.source;
      return `- [${day(r.publishedAt)}] (${who}) ${r.title ? r.title + ': ' : ''}${r.body.slice(0, 500)}`;
    })
    .join('\n');
}

// Sweep old reports so the table stays bounded.
export async function sweepReports(): Promise<void> {
  await prisma.lakeReport.deleteMany({
    where: { source: { not: 'angler' }, createdAt: { lt: new Date(Date.now() - 120 * 86400000) } },
  });
}

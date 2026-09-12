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

/** Lines that are site furniture, not content, on every agency page. */
const BOILERPLATE = [
  /javascript/i, /skip to (content|main)/i, /cookie/i, /privacy polic/i,
  /subscriber preferences|children under 13/i, /^\s*(home|menu|search|share|print)\s*$/i,
  /follow us|social media|sign up for/i, /copyright|all rights reserved/i,
  /accessibility|site map|contact us$/i, /^\s*\d{3}[-.]\d{3}[-.]\d{4}\s*$/,
];

/** Words that mean a paragraph is actually about fishing this water. */
const SIGNAL = /\b(fish|fishing|angler|bass|crappie|catfish|walleye|trout|perch|bream|bluegill|stripe[rd]|hybrid|spawn|habitat|structure|brush|timber|cover|ramp|jig|crankbait|shad|minnow|lure|bait|depth|acre|reservoir|stock(ed|ing)?|regulation|limit|alga|water level|clarity)\b/i;

/**
 * Pull the part of a fetched page that is actually about fishing this lake.
 *
 * The naive version — text around the first mention of the lake name — reliably
 * grabbed the page title and the "this site needs JavaScript" notice underneath
 * it, and stored that as a fishing report. Score the paragraphs instead, drop
 * the furniture, and return nothing at all when nothing scores: an empty
 * report is honest, a page of navigation in the planner's prompt is not.
 *
 * Exported for tests.
 */
export function extractReportText(text: string, lakeName: string, budget = 1400): string {
  const name = lakeName.replace(/^lake\s+/i, '').replace(/\s+(lake|reservoir)$/i, '').toLowerCase();
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !BOILERPLATE.some((re) => re.test(p)));

  const scored = paras
    .map((p) => {
      const hits = (p.match(new RegExp(SIGNAL, 'gi')) || []).length;
      const named = name.length >= 3 && p.toLowerCase().includes(name) ? 1 : 0;
      // Long lists of links score badly: lots of pipes, few sentences.
      const listy = (p.match(/\|/g) || []).length > 2 ? -2 : 0;
      return { p, score: hits + named * 2 + listy };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return '';

  const out: string[] = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.length > budget) continue;
    out.push(p);
    used += p.length;
    if (used > budget * 0.8) break;
  }
  return out.join('\n');
}

/**
 * State fishing reports that are actually reports.
 *
 * The TPWD page we were scraping is a static lake profile — good background,
 * but it has no date, and we were stamping it with the time we fetched it and
 * re-stamping it every six hours, so a page unchanged since February looked
 * like this morning's news. These three are different: a real report, written
 * on a real date, naming real lakes.
 */
export const STATE_SOURCES = [
  { state: 'Oklahoma', name: 'ODWC fishing report', url: 'https://www.wildlifedepartment.com/fishing/fishingreport', kind: 'html' as const },
  { state: 'Arkansas', name: 'AGFC weekly fishing report', url: 'https://www.agfc.com/tag/arkansas-wildlife-fishing-report/feed/', kind: 'rss' as const },
  { state: 'Michigan', name: 'Michigan DNR weekly fishing report', url: 'https://public.govdelivery.com/topics/MIDNR_9/feed.rss', kind: 'rss' as const },
];

/** Does this lake sit in that state? Regions are free text like "Hood County, Texas". */
export function isState(region: string | null, country: string | null, state: string): boolean {
  if (country && !/^(us|usa|united states)$/i.test(country)) return false;
  const r = (region || '').toLowerCase();
  return r.includes(state.toLowerCase());
}

/**
 * Split a report page into the chunks a lake could be named in.
 *
 * All three feeds are one long page covering dozens of waters, laid out as a
 * heading per lake or region followed by its paragraphs. Matching on "does the
 * lake's name appear anywhere" put Broken Bow's report under Texoma; a block
 * is only about a lake when the lake is named in the block's own HEADING, or
 * when the block is short enough to be about one thing.
 */
export interface Block { heading: string; text: string }
export function blocksFrom(html: string): Block[] {
  const src = String(html || '');
  const out: Block[] = [];
  // Walk the headings in order; everything between one heading and the next
  // belongs to it. Splitting on tags alone put a lake's name in one piece and
  // its report in the next, so every section came back as a bare title.
  const heading = /<(h[1-4])\b[^>]*>([\s\S]{0,200}?)<\/\1>|<(?:strong|b)\b[^>]*>([\s\S]{0,120}?)<\/(?:strong|b)>/gi;
  let m: RegExpExecArray | null;
  const marks: { at: number; end: number; title: string }[] = [];
  while ((m = heading.exec(src))) {
    const title = htmlToText(m[2] ?? m[3] ?? '').trim();
    if (title) marks.push({ at: m.index, end: heading.lastIndex, title });
  }
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : Math.min(src.length, marks[i].end + 6000));
    const text = htmlToText(body).trim();
    out.push({ heading: marks[i].title, text: `${marks[i].title}. ${text}`.slice(0, 4000) });
  }
  // Whatever came before the first heading is still worth having.
  if (marks.length) {
    const lead = htmlToText(src.slice(0, marks[0].at)).trim();
    if (lead) out.unshift({ heading: '', text: lead.slice(0, 4000) });
  } else {
    const all = htmlToText(src).trim();
    if (all) out.push({ heading: '', text: all.slice(0, 4000) });
  }
  return out;
}

/** Normalised name tokens: "Broken Bow Lake" and "Broken Bow Lake Report" match. */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/\b(lake|reservoir|res|report|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The part of a multi-lake page that is about ONE lake, or '' if none is. */
export function sectionFor(blocks: Block[], lakeName: string, budget = 1400): string {
  const want = nameKey(lakeName);
  if (want.length < 3) return '';
  const hit = blocks.filter((b) => b.heading && nameKey(b.heading).includes(want));
  if (hit.length) return hit.map((b) => b.text).join('\n').slice(0, budget);
  // No heading names it; accept a short block that does, since a paragraph
  // about one lake is still a report about that lake.
  const inline = blocks.filter((b) => b.text.length < 900 && nameKey(b.text).includes(want));
  return inline.length ? inline.map((b) => b.text).join('\n').slice(0, budget) : '';
}

/**
 * Numbers buried in the prose. Oklahoma's wardens write "Elevation is 8 ft.
 * below normal (falling), water temperature 86°F and clear" — which is a water
 * temperature and a lake level for a lake that may have no gauge at all.
 */
export interface ReportFacts { waterTempF?: number; levelNote?: string; clarity?: string; reportedOn?: string }
export function factsFrom(text: string): ReportFacts {
  const out: ReportFacts = {};
  const t = String(text || '');
  const temp = /water temperature[^0-9]{0,12}(\d{2,3})\s*°?\s*F/i.exec(t);
  if (temp) {
    const f = Number(temp[1]);
    if (f >= 32 && f <= 100) out.waterTempF = f;
  }
  // Stop at a comma or a line break, not at a full stop: "8 ft. below normal"
  // has a period in the middle of it, and an `i`-flagged [A-Z] happily matched
  // the lowercase "below" that follows.
  const lvl = /elevation is ([^,;\n]{3,60})/i.exec(t);
  if (lvl) out.levelNote = lvl[1].trim().replace(/[.\s]+$/, '').slice(0, 60);
  const clar = /\b(clear|stained|murky|muddy|slightly stained|dingy)\b/i.exec(t);
  if (clar) out.clarity = clar[1].toLowerCase();
  const when = /^\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2})\b/.exec(t);
  if (when) out.reportedOn = when[1];
  return out;
}

/** "Sep 11" in a report written this year → a real date, not the fetch time. */
export function dateFromText(text: string, now = new Date()): Date | null {
  const m = /\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\b/.exec(String(text || '').slice(0, 60));
  if (!m) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  if (month < 0 || !day || day > 31) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), month, day, 12));
  // A report dated in the future is last year's — reports never look forward.
  if (d.getTime() > now.getTime() + 86400_000) d.setUTCFullYear(now.getUTCFullYear() - 1);
  return d;
}

export async function fetchText(url: string): Promise<string> {
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
      if (looksLikeSoft404(htmlToText(text))) throw new Error('page answered 200 with a "not found" body');
      // Keep the markup: headings are what tell one lake's section from the
      // next, and htmlToText throws them away. Trimmed per lake below.
      items = [{ body: text, url: src.url }];   // a page carries no date of its own
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
        // A page covering many lakes is cut down to this lake's own section;
        // a feed item is already the unit. Pinned single-lake pages fall back
        // to the old scorer, which is right for a page about one water.
        let body: string;
        if (src.kind === 'html') {
          body = src.lakeId
            ? extractReportText(htmlToText(item.body), lake.name)
            : sectionFor(blocksFrom(item.body), lake.name);
        } else {
          body = sectionFor(blocksFrom(item.body), lake.name) || item.body.slice(0, MAX_BODY);
        }
        if (!body) continue; // nothing on the page was about fishing this water

        // What kind of thing is this? A dated report, or a standing profile?
        // Calling a static lake description "today's agency report" is the
        // difference between information and a lie.
        const facts = factsFrom(body);
        const reported: Date | null = item.publishedAt || dateFromText(body) || null;
        const kind = reported ? 'agency' : 'profile';
        const header = [
          facts.waterTempF ? `water ${facts.waterTempF}°F` : '',
          facts.levelNote ? `level ${facts.levelNote}` : '',
          facts.clarity ? `water ${facts.clarity}` : '',
        ].filter(Boolean).join(' · ');
        const stamped = header ? `${header}\n${body}` : body;

        // A dated item keys on its date as well, so a weekly feed builds up a
        // history instead of overwriting one row forever.
        const key = reported
          ? `${item.url || src.url}#${reported.toISOString().slice(0, 10)}`
          : item.url || src.url;
        await prisma.lakeReport.upsert({
          where: { lakeId_url: { lakeId: lake.id, url: key } },
          create: {
            lakeId: lake.id,
            source: kind,
            sourceName: src.name,
            title: item.title?.slice(0, 200) || null,
            body: stamped,
            url: key,
            // A profile has no date, and inventing one is how a page unchanged
            // since February came to look like this morning's news.
            publishedAt: reported,
          },
          // Never re-stamp with the fetch time — but do correct a row we
          // previously mis-filed: if we now know the page carries no date, the
          // honest value is no date, not the one we invented for it.
          update: { body: stamped, source: kind, publishedAt: reported },
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
/**
 * Make sure each state we have a real report feed for has that feed attached.
 * One source row per state, matched to lakes by region, the same way the
 * Texas sources already work.
 */
export async function attachStateSources(): Promise<number> {
  let added = 0;
  for (const src of STATE_SOURCES) {
    const exists = await prisma.reportSource.findFirst({ where: { url: src.url } });
    if (exists) continue;
    const lakes = await prisma.lake.count({ where: { region: { contains: src.state, mode: 'insensitive' } } });
    if (!lakes) continue; // nobody fishes that state here yet
    await prisma.reportSource.create({
      data: { name: src.name, url: src.url, kind: src.kind, region: src.state, active: true },
    });
    added += 1;
  }
  return added;
}

export async function refreshAllSources(): Promise<{ sources: number; stored: number }> {
  await attachStateSources().catch(() => 0);
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
    // Dated reports from the window, plus anything that has no date at all —
    // a lake description and a stocking history are standing facts, not news,
    // and filtering on a date window would hide them forever.
    where: {
      lakeId,
      OR: [
        { publishedAt: { gte: new Date(Date.now() - days * 86400000) } },
        { publishedAt: null },
      ],
    },
    orderBy: { publishedAt: 'desc' },
    take,
    select: { source: true, sourceName: true, title: true, body: true, url: true, publishedAt: true },
  });
}

/** Trim reports into the block the day-plan prompt carries. */
export function reportsForPrompt(rows: Awaited<ReturnType<typeof recentReports>>): string {
  if (!rows.length) return '';
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'undated');
  // Dated reports first, and a standing lake description labelled as one: a
  // model told "agency report" about a page written last winter will happily
  // present it as current.
  const sorted = [...rows].sort((a, b) => {
    const ad = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bd = b.publishedAt ? b.publishedAt.getTime() : 0;
    return bd - ad;
  });
  return sorted
    .map((r) => {
      const who = r.source === 'angler'
        ? `angler ${r.sourceName || ''}`.trim()
        : r.source === 'profile'
          ? `${r.sourceName || 'agency'} — standing lake description, UNDATED, background only`
          : r.source === 'stocking'
            ? `${r.sourceName || 'agency'} — stocking history, the years are in the text`
            : r.sourceName || r.source;
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

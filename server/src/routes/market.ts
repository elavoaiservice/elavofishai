/**
 * Classifieds — the gear board.
 *
 * Unlike everything else here, a listing has no audience setting: putting gear
 * up for sale is asking to be found, so every signed-in angler sees it. Blocks
 * still apply in both directions, and the seller's contact stays behind the
 * app's own messaging rather than an email address in the body.
 *
 * We take no payment and hold no escrow. This is a noticeboard; the deal is
 * between the two anglers, and the UI says so.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { blockedUserIds, blockState } from '../lib/social';
import { deleteObject } from '../services/storage';

export const CATEGORIES = ['rods', 'reels', 'electronics', 'boats', 'tackle', 'other'] as const;
export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'parts'] as const;
const MAX_PHOTOS = 6;

/** "$249.99" from the cents we store, or null for make-an-offer. */
export function formatPrice(cents: number | null): string | null {
  if (cents === null || cents === undefined) return null;
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/**
 * Accept what people actually type — "249", "$249.99", "1,200" — and refuse
 * what we cannot price honestly rather than rounding it into something wrong.
 */
export function parsePrice(input: unknown): number | null | undefined {
  if (input === null || input === undefined || input === '') return null;
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 100_000_000) return undefined;
  return cents;
}

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/market', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const q = req.query as { category?: string; q?: string; mine?: string; sellerId?: string; limit?: string };
    const take = Math.min(Math.max(Number(q.limit) || 30, 1), 60);
    const blocked = await blockedUserIds(me.id);
    const search = String(q.q || '').trim().slice(0, 80);

    const listings = await prisma.listing.findMany({
      where: {
        sellerId: q.mine === '1' ? me.id : q.sellerId ? String(q.sellerId) : { notIn: blocked },
        // Your own withdrawn ads stay visible to you; everyone else sees the board.
        status: q.mine === '1' ? undefined : { in: ['active', 'sold'] },
        category: q.category && (CATEGORIES as readonly string[]).includes(q.category) ? q.category : undefined,
        ...(search
          ? { OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { body: { contains: search, mode: 'insensitive' as const } }] }
          : {}),
      },
      include: {
        seller: { select: { id: true, displayName: true, avatarUrl: true, location: true } },
        lake: { select: { id: true, name: true } },
        photos: { select: { id: true } },
      },
      orderBy: [{ status: 'asc' }, { bumpedAt: 'desc' }],
      take,
    });

    return {
      categories: CATEGORIES,
      listings: listings.map((l) => ({
        id: l.id,
        title: l.title,
        body: l.body,
        price: formatPrice(l.priceCents),
        priceCents: l.priceCents,
        category: l.category,
        condition: l.condition,
        location: l.location,
        lake: l.lake,
        status: l.status,
        createdAt: l.createdAt,
        bumpedAt: l.bumpedAt,
        seller: l.seller,
        mine: l.sellerId === me.id,
        photos: l.photos.map((p) => p.id),
      })),
    };
  });

  app.post('/api/market', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (await overLimit(`listing:${me.id}`, 20, 86400_000)) {
      return reply.code(429).send({ error: 'That is a lot of listings today — try again tomorrow.' });
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const title = String(b.title || '').trim().slice(0, 120);
    const body = String(b.body || '').trim().slice(0, 5000);
    if (!title) return reply.code(400).send({ error: 'Give the listing a title.' });
    const priceCents = parsePrice(b.price);
    if (priceCents === undefined) return reply.code(400).send({ error: 'Price should be a number, like 249 or 249.99.' });
    const category = (CATEGORIES as readonly string[]).includes(String(b.category)) ? String(b.category) : 'other';
    const condition = (CONDITIONS as readonly string[]).includes(String(b.condition)) ? String(b.condition) : null;

    const listing = await prisma.listing.create({
      data: {
        sellerId: me.id, title, body, priceCents, category, condition,
        location: b.location ? String(b.location).trim().slice(0, 80) : null,
        lakeId: b.lakeId ? String(b.lakeId) : null,
      },
    });
    const photoIds = Array.isArray(b.photoIds) ? b.photoIds.map(String).slice(0, MAX_PHOTOS) : [];
    if (photoIds.length) {
      await prisma.photo.updateMany({
        where: { id: { in: photoIds }, userId: me.id, tripId: null, postId: null, listingId: null },
        data: { listingId: listing.id },
      });
    }
    return reply.send({ listing: { id: listing.id } });
  });

  app.put('/api/market/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const existing = await prisma.listing.findFirst({ where: { id, sellerId: me.id } });
    if (!existing) return reply.code(404).send({ error: 'No such listing.' });
    const b = (req.body || {}) as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (typeof b.title === 'string') data.title = b.title.trim().slice(0, 120) || existing.title;
    if (typeof b.body === 'string') data.body = b.body.trim().slice(0, 5000);
    if ('price' in b) {
      const cents = parsePrice(b.price);
      if (cents === undefined) return reply.code(400).send({ error: 'Price should be a number, like 249 or 249.99.' });
      data.priceCents = cents;
    }
    if (typeof b.category === 'string' && (CATEGORIES as readonly string[]).includes(b.category)) data.category = b.category;
    if (typeof b.condition === 'string' && (CONDITIONS as readonly string[]).includes(b.condition)) data.condition = b.condition;
    if (typeof b.location === 'string') data.location = b.location.trim().slice(0, 80) || null;
    if (typeof b.status === 'string' && ['active', 'sold', 'withdrawn'].includes(b.status)) {
      data.status = b.status;
      data.soldAt = b.status === 'sold' ? new Date() : null;
    }
    // A bump re-sorts the board without rewriting when the ad was posted, so
    // "listed 3 months ago" stays true.
    if (b.bump === true) data.bumpedAt = new Date();

    const l = await prisma.listing.update({ where: { id }, data });
    return reply.send({ listing: { id: l.id, status: l.status, price: formatPrice(l.priceCents) } });
  });

  app.delete('/api/market/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const listing = await prisma.listing.findFirst({ where: { id, sellerId: me.id }, include: { photos: { select: { key: true } } } });
    if (!listing) return reply.code(404).send({ error: 'No such listing.' });
    for (const p of listing.photos) await deleteObject(p.key).catch(() => {});
    await prisma.listing.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  /**
   * Message a seller about a listing.
   *
   * This deliberately ignores the seller's "friends only" message setting:
   * posting an ad is an invitation to be contacted about it, and a board where
   * you cannot reach the seller is not a board. A block still stops it dead.
   */
  app.post('/api/market/:id/contact', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const body = String((req.body as { body?: string }).body || '').trim().slice(0, 2000);
    if (!body) return reply.code(400).send({ error: 'Write a message first.' });
    const listing = await prisma.listing.findUnique({ where: { id }, select: { sellerId: true, title: true, status: true } });
    if (!listing) return reply.code(404).send({ error: 'No such listing.' });
    if (listing.sellerId === me.id) return reply.code(400).send({ error: 'That is your own listing.' });
    if ((await blockState(me.id, listing.sellerId)) !== 'none') return reply.code(404).send({ error: 'No such listing.' });
    if (await overLimit(`contact:${me.id}`, 30, 3600_000)) {
      return reply.code(429).send({ error: 'Too many messages this hour — try again later.' });
    }
    await prisma.message.create({
      data: { senderId: me.id, recipientId: listing.sellerId, body: `Re: ${listing.title}\n\n${body}` },
    });
    return reply.send({ ok: true });
  });
}

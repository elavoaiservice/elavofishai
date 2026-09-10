/**
 * Walls and the feed.
 *
 * Three surfaces, one rule set. A post is visible to a viewer when:
 *   - they wrote it, or
 *   - it is a group post and they are in that group, or
 *   - it is public, or
 *   - it is friends-only and they are an accepted friend of the author.
 * A block beats all of it, in both directions.
 *
 * The feed reads that rule the other way round — the set of posts a viewer may
 * see — so the same sentence governs both and they cannot drift apart.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { areFriends, blockedUserIds, blockState, friendIds } from '../lib/social';
import { canModerate, canPost, roleIn } from '../lib/groups';
import { myGroupIds } from '../lib/sharing';
import { deleteObject } from '../services/storage';

const MAX_BODY = 5000;
const MAX_PHOTOS = 4;
const VISIBILITIES = new Set(['private', 'friends', 'public']);

type PostRow = {
  id: string;
  authorId: string;
  groupId: string | null;
  lakeId: string | null;
  body: string;
  visibility: string;
  pinned: boolean;
  createdAt: Date;
  author: { id: string; displayName: string; avatarUrl: string | null };
  group?: { id: string; name: string } | null;
  lake?: { id: string; name: string } | null;
  photos: { id: string }[];
  comments: { id: string; body: string; createdAt: Date; author: { id: string; displayName: string; avatarUrl: string | null } }[];
  _count?: { reactions: number };
  reactions?: { userId: string }[];
};

const INCLUDE = {
  author: { select: { id: true, displayName: true, avatarUrl: true } },
  group: { select: { id: true, name: true } },
  lake: { select: { id: true, name: true } },
  photos: { select: { id: true } },
  comments: {
    orderBy: { createdAt: 'asc' as const },
    take: 20,
    include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
  },
  _count: { select: { reactions: true } },
};

function shape(p: PostRow, meId: string, likedIds: Set<string>) {
  return {
    id: p.id,
    body: p.body,
    visibility: p.visibility,
    pinned: p.pinned,
    createdAt: p.createdAt,
    mine: p.authorId === meId,
    author: p.author,
    group: p.group ?? null,
    lake: p.lake ?? null,
    photos: p.photos.map((x) => x.id),
    likes: p._count?.reactions ?? 0,
    liked: likedIds.has(p.id),
    comments: p.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: c.author, mine: c.author.id === meId })),
  };
}

/** Which of these posts has the viewer already liked? One query, not N. */
async function likedSet(meId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await prisma.postReaction.findMany({ where: { userId: meId, postId: { in: ids } }, select: { postId: true } });
  return new Set(rows.map((r) => r.postId));
}

/** Attach photos the viewer uploaded and hasn't already hung on something. */
async function attachPhotos(photoIds: unknown, userId: string, where: { postId: string } | { listingId: string }) {
  const ids = Array.isArray(photoIds) ? photoIds.map(String).slice(0, MAX_PHOTOS) : [];
  if (!ids.length) return;
  await prisma.photo.updateMany({
    where: { id: { in: ids }, userId, tripId: null, postId: null, listingId: null },
    data: where,
  });
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  // ---------- writing ----------
  app.post('/api/posts', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (await overLimit(`post:${me.id}`, 60, 3600_000)) {
      return reply.code(429).send({ error: 'Slow down a little — try again shortly.' });
    }
    const b = (req.body || {}) as { body?: string; groupId?: string; lakeId?: string; visibility?: string; photoIds?: unknown };
    const body = String(b.body || '').trim().slice(0, MAX_BODY);
    const photoIds = Array.isArray(b.photoIds) ? b.photoIds.map(String).slice(0, MAX_PHOTOS) : [];
    if (!body && !photoIds.length) return reply.code(400).send({ error: 'Write something, or add a photo.' });

    let groupId: string | null = null;
    if (b.groupId) {
      groupId = String(b.groupId);
      if (!canPost(await roleIn(groupId, me.id))) {
        return reply.code(403).send({ error: 'You can read this group but not post to it.' });
      }
    }
    const visibility = groupId ? 'group' : VISIBILITIES.has(String(b.visibility)) ? String(b.visibility) : 'friends';

    const post = await prisma.post.create({
      data: { authorId: me.id, groupId, lakeId: b.lakeId ? String(b.lakeId) : null, body, visibility },
    });
    await attachPhotos(photoIds, me.id, { postId: post.id });
    const full = (await prisma.post.findUnique({ where: { id: post.id }, include: INCLUDE })) as unknown as PostRow;
    return reply.send({ post: shape(full, me.id, new Set()) });
  });

  app.delete('/api/posts/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const post = await prisma.post.findUnique({ where: { id }, select: { authorId: true, groupId: true } });
    if (!post) return reply.code(404).send({ error: 'No such post.' });
    const allowed = post.authorId === me.id || (post.groupId ? canModerate(await roleIn(post.groupId, me.id)) : false);
    if (!allowed) return reply.code(403).send({ error: 'Not your post.' });
    // The Photo rows cascade with the post and hold the only pointer into the
    // bucket, so the objects go first.
    const photos = await prisma.photo.findMany({ where: { postId: id }, select: { key: true } });
    for (const p of photos) await deleteObject(p.key).catch(() => {});
    await prisma.post.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // ---------- reading ----------
  /** Everything the viewer is allowed to see, newest first. */
  app.get('/api/feed', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const q = req.query as { before?: string; limit?: string };
    const take = Math.min(Math.max(Number(q.limit) || 25, 1), 50);
    const [friends, blocked, groups] = await Promise.all([friendIds(me.id), blockedUserIds(me.id), myGroupIds(me.id)]);
    const visible = friends.filter((f) => !blocked.includes(f));

    const posts = (await prisma.post.findMany({
      where: {
        createdAt: q.before ? { lt: new Date(String(q.before)) } : undefined,
        authorId: { notIn: blocked },
        OR: [
          { authorId: me.id },
          { groupId: { in: groups } },
          { groupId: null, visibility: 'public' },
          { groupId: null, visibility: 'friends', authorId: { in: visible } },
        ],
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take,
    })) as unknown as PostRow[];

    const liked = await likedSet(me.id, posts.map((p) => p.id));
    return {
      posts: posts.map((p) => shape(p, me.id, liked)),
      nextBefore: posts.length === take ? posts[posts.length - 1].createdAt : null,
    };
  });

  /** One angler's page. Their profile, and the posts this viewer may see. */
  app.get('/api/users/:id/wall', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    if ((await blockState(me.id, id)) !== 'none') return reply.code(404).send({ error: 'No such angler.' });
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, displayName: true, avatarUrl: true, location: true, bio: true,
        favoriteSpecies: true, favoriteLure: true, hasBoat: true, boatType: true,
        yearsFishing: true, createdAt: true, discoverability: true,
        favoriteLake: { select: { id: true, name: true } },
      },
    });
    if (!user) return reply.code(404).send({ error: 'No such angler.' });

    const mine = id === me.id;
    const friend = mine || (await areFriends(me.id, id));
    // Not searchable and not a friend: the page exists, but it is not theirs to read.
    if (!mine && !friend && user.discoverability === 'nobody') {
      return reply.code(403).send({ error: 'This angler keeps their page private.' });
    }

    const posts = (await prisma.post.findMany({
      where: {
        authorId: id,
        groupId: null,
        ...(mine ? {} : friend ? { visibility: { in: ['public', 'friends'] } } : { visibility: 'public' }),
      },
      include: INCLUDE,
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    })) as unknown as PostRow[];
    const liked = await likedSet(me.id, posts.map((p) => p.id));

    const [catches, friendCount] = await Promise.all([
      prisma.trip.findMany({
        where: { userId: id, ...(mine ? {} : friend ? { visibility: { in: ['public', 'friends'] } } : { visibility: 'public' }) },
        include: { photos: { select: { id: true } }, lake: { select: { id: true, name: true } } },
        orderBy: { date: 'desc' },
        take: 10,
      }),
      prisma.friendship.count({ where: { status: 'accepted', OR: [{ userId: id }, { friendId: id }] } }),
    ]);

    const { discoverability: _d, ...profile } = user;
    return {
      user: { ...profile, isMe: mine, isFriend: friend, friendCount },
      posts: posts.map((p) => shape(p, me.id, liked)),
      catches: catches.map((c) => ({
        id: c.id, species: c.species, weight: c.weight, lure: c.lure, date: c.date,
        lake: c.lake ? { id: c.lake.id, name: c.lake.name } : null,
        photos: c.photos.map((p) => p.id),
      })),
    };
  });

  // ---------- comments ----------
  app.post('/api/posts/:id/comments', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const body = String((req.body as { body?: string }).body || '').trim().slice(0, 2000);
    if (!body) return reply.code(400).send({ error: 'Say something first.' });
    if (!(await canSee(me.id, id))) return reply.code(403).send({ error: 'Not shared with you.' });
    const c = await prisma.postComment.create({
      data: { postId: id, authorId: me.id, body },
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    return reply.send({ comment: { id: c.id, body: c.body, createdAt: c.createdAt, author: c.author, mine: true } });
  });

  app.delete('/api/comments/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const c = await prisma.postComment.findUnique({
      where: { id },
      include: { post: { select: { authorId: true, groupId: true } } },
    });
    if (!c) return reply.code(404).send({ error: 'No such comment.' });
    // Your own comment, your own post, or a group you moderate.
    const allowed =
      c.authorId === me.id ||
      c.post.authorId === me.id ||
      (c.post.groupId ? canModerate(await roleIn(c.post.groupId, me.id)) : false);
    if (!allowed) return reply.code(403).send({ error: 'Not yours to remove.' });
    await prisma.postComment.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // ---------- reactions ----------
  app.post('/api/posts/:id/like', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    if (!(await canSee(me.id, id))) return reply.code(403).send({ error: 'Not shared with you.' });
    await prisma.postReaction.upsert({
      where: { postId_userId: { postId: id, userId: me.id } },
      create: { postId: id, userId: me.id, kind: 'like' },
      update: {},
    });
    return reply.send({ ok: true, likes: await prisma.postReaction.count({ where: { postId: id } }), liked: true });
  });

  app.delete('/api/posts/:id/like', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    await prisma.postReaction.deleteMany({ where: { postId: id, userId: me.id } });
    return reply.send({ ok: true, likes: await prisma.postReaction.count({ where: { postId: id } }), liked: false });
  });
}

/**
 * The visibility rule, in one place. Everything that reads or writes against a
 * single post asks this; the feed asks the same question as a query.
 */
export async function canSee(meId: string, postId: string): Promise<boolean> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { authorId: true, groupId: true, visibility: true },
  });
  if (!post) return false;
  if (post.authorId === meId) return true;
  if ((await blockState(meId, post.authorId)) !== 'none') return false;
  if (post.groupId) return (await roleIn(post.groupId, meId)) !== null;
  if (post.visibility === 'public') return true;
  if (post.visibility === 'friends') return areFriends(meId, post.authorId);
  return false;
}

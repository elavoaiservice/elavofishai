/**
 * The group page: a wall the whole crew reads, with roles deciding who may
 * write on it and who may run it. See lib/groups.ts for the four roles.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import {
  ASSIGNABLE,
  canAdminister,
  canRead,
  canPost,
  canModerate,
  canSetRole,
  roleIn,
  type GroupRole,
} from '../lib/groups';

export async function groupPageRoutes(app: FastifyInstance): Promise<void> {
  /** The page itself: who's in it, what they can do, and the posts. */
  app.get('/api/groups/:id/page', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const role = await roleIn(id, me.id);
    // A group is not a public object — outsiders are told nothing about it.
    if (!canRead(role)) return reply.code(404).send({ error: 'No such group.' });

    const group = await prisma.friendGroup.findUniqueOrThrow({
      where: { id },
      include: {
        owner: { select: { id: true, displayName: true, avatarUrl: true } },
        members: {
          include: { member: { select: { id: true, displayName: true, avatarUrl: true } } },
          orderBy: { addedAt: 'asc' },
        },
      },
    });

    const posts = await prisma.post.findMany({
      where: { groupId: id },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
        lake: { select: { id: true, name: true } },
        photos: { select: { id: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          take: 20,
          include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
        },
        _count: { select: { reactions: true } },
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    });
    const likedRows = await prisma.postReaction.findMany({
      where: { userId: me.id, postId: { in: posts.map((p) => p.id) } },
      select: { postId: true },
    });
    const liked = new Set(likedRows.map((r) => r.postId));

    return {
      group: {
        id: group.id,
        name: group.name,
        about: group.about,
        createdAt: group.createdAt,
        owner: group.owner,
        members: [
          { ...group.owner, role: 'owner' as const },
          ...group.members.map((m) => ({ ...m.member, role: m.role })),
        ],
      },
      me: {
        role,
        canPost: canPost(role),
        canModerate: canModerate(role),
        canAdminister: canAdminister(role),
      },
      posts: posts.map((p) => ({
        id: p.id,
        body: p.body,
        pinned: p.pinned,
        createdAt: p.createdAt,
        mine: p.authorId === me.id,
        author: p.author,
        lake: p.lake,
        photos: p.photos.map((x) => x.id),
        likes: p._count.reactions,
        liked: liked.has(p.id),
        comments: p.comments.map((c) => ({
          id: c.id, body: c.body, createdAt: c.createdAt, author: c.author, mine: c.author.id === me.id,
        })),
      })),
    };
  });

  /** Rename the group or rewrite its description. Owner only. */
  app.put('/api/groups/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const role = await roleIn(id, me.id);
    if (!canRead(role)) return reply.code(404).send({ error: 'No such group.' });
    if (!canAdminister(role)) return reply.code(403).send({ error: 'Only the owner can change the group.' });
    const b = (req.body || {}) as { name?: string; about?: string };
    const data: { name?: string; about?: string | null } = {};
    if (typeof b.name === 'string') {
      const name = b.name.trim().slice(0, 60);
      if (!name) return reply.code(400).send({ error: 'Name your group.' });
      data.name = name;
    }
    if (typeof b.about === 'string') data.about = b.about.trim().slice(0, 2000) || null;
    const g = await prisma.friendGroup.update({ where: { id }, data });
    return reply.send({ group: { id: g.id, name: g.name, about: g.about } });
  });

  /** Change a member's role. */
  app.put('/api/groups/:id/members/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const p = req.params as { id: string; userId: string };
    const next = String((req.body as { role?: string }).role || '');
    if (!ASSIGNABLE.includes(next as GroupRole)) {
      return reply.code(400).send({ error: `Role must be one of: ${ASSIGNABLE.join(', ')}.` });
    }
    const [mine, theirs] = await Promise.all([roleIn(p.id, me.id), roleIn(p.id, p.userId)]);
    if (!canRead(mine)) return reply.code(404).send({ error: 'No such group.' });
    if (theirs === null) return reply.code(404).send({ error: 'They are not in this group.' });
    if (!canSetRole(mine, theirs, next as GroupRole)) {
      return reply.code(403).send({ error: 'You cannot set that role.' });
    }
    await prisma.friendGroupMember.updateMany({
      where: { groupId: p.id, memberId: p.userId },
      data: { role: next },
    });
    return reply.send({ ok: true, role: next });
  });

  /** Pin a post to the top of the page. Editors and the owner. */
  app.put('/api/posts/:id/pin', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const pinned = (req.body as { pinned?: boolean }).pinned !== false;
    const post = await prisma.post.findUnique({ where: { id }, select: { authorId: true, groupId: true } });
    if (!post) return reply.code(404).send({ error: 'No such post.' });
    const allowed = post.groupId ? canModerate(await roleIn(post.groupId, me.id)) : post.authorId === me.id;
    if (!allowed) return reply.code(403).send({ error: 'Not yours to pin.' });
    await prisma.post.update({ where: { id }, data: { pinned } });
    return reply.send({ ok: true, pinned });
  });
}

/**
 * Reporting content.
 *
 * Deliberately separate from blocking: blocking says "not for me", flagging
 * says "not for anyone". A flag takes a snapshot of what was reported at the
 * moment it is raised — the author can delete the original a second later, and
 * then there is nothing left for an admin to look at.
 *
 * One flag per person per thing (the unique index): a second press is an
 * update, not a second complaint, so nobody can inflate a queue by tapping.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { canSee } from './posts';

export const FLAG_REASONS = ['spam', 'scam', 'harassment', 'nudity', 'illegal', 'other'] as const;
const TARGETS = ['post', 'comment', 'listing', 'user'] as const;

/** What was actually reported, captured now. Null if it is already gone. */
async function snapshotOf(targetType: string, targetId: string): Promise<string | null> {
  try {
    if (targetType === 'post') {
      const p = await prisma.post.findUnique({ where: { id: targetId }, include: { author: { select: { displayName: true } } } });
      return p ? `${p.author.displayName}: ${p.body}`.slice(0, 2000) : null;
    }
    if (targetType === 'comment') {
      const c = await prisma.postComment.findUnique({ where: { id: targetId }, include: { author: { select: { displayName: true } } } });
      return c ? `${c.author.displayName}: ${c.body}`.slice(0, 2000) : null;
    }
    if (targetType === 'listing') {
      const l = await prisma.listing.findUnique({ where: { id: targetId }, include: { seller: { select: { displayName: true } } } });
      return l ? `${l.seller.displayName} — ${l.title}\n${l.body}`.slice(0, 2000) : null;
    }
    if (targetType === 'user') {
      const u = await prisma.user.findUnique({ where: { id: targetId }, select: { displayName: true, email: true, bio: true } });
      return u ? `${u.displayName} <${u.email}>\n${u.bio || ''}`.slice(0, 2000) : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function flagRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/flags', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (await overLimit(`flag:${me.id}`, 30, 86400_000)) {
      return reply.code(429).send({ error: 'That is a lot of reports today — try again tomorrow.' });
    }
    const b = (req.body || {}) as { targetType?: string; targetId?: string; reason?: string; note?: string };
    const targetType = String(b.targetType || '');
    const targetId = String(b.targetId || '');
    const reason = String(b.reason || 'other');
    if (!(TARGETS as readonly string[]).includes(targetType) || !targetId) {
      return reply.code(400).send({ error: 'Tell us what you are reporting.' });
    }
    if (!(FLAG_REASONS as readonly string[]).includes(reason)) {
      return reply.code(400).send({ error: 'Pick a reason.' });
    }
    // You can only report something you can actually see — otherwise a flag is
    // a way to probe whether a private post exists.
    if (targetType === 'post' && !(await canSee(me.id, targetId))) {
      return reply.code(404).send({ error: 'No such post.' });
    }
    const note = String(b.note || '').trim().slice(0, 1000) || null;
    const snapshot = await snapshotOf(targetType, targetId);

    await prisma.contentFlag.upsert({
      where: { reporterId_targetType_targetId: { reporterId: me.id, targetType, targetId } },
      create: { reporterId: me.id, targetType, targetId, reason, note, snapshot },
      update: { reason, note, snapshot, status: 'open', reviewedAt: null, reviewedBy: null },
    });
    return reply.send({ ok: true });
  });

  /** What this user has already reported, so the UI can say "reported". */
  app.get('/api/flags/mine', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.contentFlag.findMany({
      where: { reporterId: me.id },
      select: { targetType: true, targetId: true, status: true },
      take: 200,
    });
    return { flags: rows };
  });
}

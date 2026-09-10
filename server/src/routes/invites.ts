/**
 * Invites — the one thing the app could not do: reach someone who is not here.
 *
 * An invite is an email address plus a code. Accepting it makes the two anglers
 * friends, because being invited *by a person* is the whole point; an invite
 * that dumped you into an empty app would be a mailing list.
 *
 * Redemption keys off the email address rather than the code, so an invite
 * still works if the recipient signs up from the front page a week later. The
 * safeguard is in redeemInvites(): only an account created *after* the invite
 * becomes an automatic friendship. An invite aimed at an existing account turns
 * into an ordinary friend request instead, so nobody can add themselves to a
 * stranger's crew by typing their address.
 */
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { blockState } from '../lib/social';
import { inviteEmail, sendEmail } from '../services/email';
import { notify } from '../services/notify';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteUrl(baseUrl: string, code: string, email: string): string {
  return `${baseUrl.replace(/\/$/, '')}/signup?invite=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`;
}

export async function inviteRoutes(app: FastifyInstance, opts: { baseUrlFor: (req: unknown) => string }): Promise<void> {
  app.get('/api/invites', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.invite.findMany({
      where: { inviterId: me.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { acceptedBy: { select: { id: true, displayName: true } } },
    });
    return {
      invites: rows.map((i) => ({
        id: i.id,
        email: i.email,
        note: i.note,
        sent: !!i.sentAt,
        accepted: !!i.acceptedAt,
        acceptedBy: i.acceptedBy,
        revoked: !!i.revokedAt,
        createdAt: i.createdAt,
      })),
    };
  });

  app.post('/api/invites', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (await overLimit(`invite:${me.id}`, 20, 86400_000)) {
      return reply.code(429).send({ error: 'That is a lot of invites today — try again tomorrow.' });
    }
    const b = (req.body || {}) as { email?: string; note?: string };
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Enter a valid email address.' });
    if (email === me.email) return reply.code(400).send({ error: "That's you!" });

    // Already here: an invite would be confusing, a friend request is the move.
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, displayName: true } });
    if (existing) {
      return reply.code(409).send({
        error: `${existing.displayName} is already on ElavoFishAI — send them a friend request instead.`,
        userId: existing.id,
      });
    }
    const pending = await prisma.invite.findFirst({
      where: { inviterId: me.id, email, acceptedAt: null, revokedAt: null },
      select: { id: true },
    });
    if (pending) return reply.code(409).send({ error: 'You have already invited that address.' });

    const note = String(b.note || '').trim().slice(0, 500) || null;
    const code = crypto.randomBytes(16).toString('base64url');
    const invite = await prisma.invite.create({ data: { code, inviterId: me.id, email, note } });

    const url = inviteUrl(opts.baseUrlFor(req), code, email);
    const mail = inviteEmail(me.displayName, url, note);
    const sent = await sendEmail(email, mail.subject, mail.html);
    if (sent) await prisma.invite.update({ where: { id: invite.id }, data: { sentAt: new Date() } });
    else {
      // Don't leave a row claiming an invite was sent when it never left the
      // building — say so, and let them try again.
      await prisma.invite.delete({ where: { id: invite.id } });
      return reply.code(503).send({ error: "We couldn't send that invite just now. Try again in a minute." });
    }
    return reply.send({ ok: true, invite: { id: invite.id, email } });
  });

  app.delete('/api/invites/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    // Revoked, not deleted: the row is the record that we emailed this person.
    await prisma.invite.updateMany({ where: { id, inviterId: me.id, acceptedAt: null }, data: { revokedAt: new Date() } });
    return reply.send({ ok: true });
  });
}

/**
 * Called once a magic link has produced a session. Returns how many invites
 * were turned into friendships, for logging.
 */
export async function redeemInvites(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, createdAt: true, displayName: true } });
  if (!user) return 0;
  const invites = await prisma.invite.findMany({
    where: { email: user.email, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  let done = 0;
  for (const inv of invites) {
    if (inv.inviterId === userId) continue;
    if ((await blockState(userId, inv.inviterId)) !== 'none') continue;

    // A brand-new account is one created after the invite was written; that is
    // what makes the automatic friendship safe.
    const isNew = user.createdAt.getTime() >= inv.createdAt.getTime();
    const already = await prisma.friendship.findFirst({
      where: { OR: [{ userId, friendId: inv.inviterId }, { userId: inv.inviterId, friendId: userId }] },
      select: { id: true, status: true },
    });
    if (!already) {
      await prisma.friendship.create({
        data: {
          userId: inv.inviterId,
          friendId: userId,
          requestedBy: inv.inviterId,
          status: isNew ? 'accepted' : 'pending',
        },
      });
    }
    await prisma.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedById: userId } });
    await notify({
      userId: inv.inviterId,
      actorId: userId,
      type: isNew ? 'invite_accepted' : 'friend_request',
      snippet: user.displayName,
    });
    done += 1;
  }
  return done;
}

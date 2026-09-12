/**
 * Registering a browser for push, and the follow-up question about a plan.
 *
 * Both exist for the same reason: the app can only learn from, or reach,
 * someone who is not currently looking at it.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { publicKey, pushConfigured, sendToUser } from '../services/push';

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  /** What the browser needs before it can subscribe. */
  app.get('/api/push/key', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { configured: pushConfigured(), publicKey: publicKey() };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const b = (req.body || {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const endpoint = String(b.endpoint || '');
    const p256dh = String(b.keys?.p256dh || '');
    const auth = String(b.keys?.auth || '');
    if (!endpoint || !p256dh || !auth) return reply.code(400).send({ error: 'Incomplete subscription.' });
    // Upsert on the endpoint: the same browser re-subscribing must not leave a
    // second row that we then push to twice.
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: me.id, endpoint, p256dh, auth, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
      update: { userId: me.id, p256dh, auth, failedAt: null },
    });
    return reply.send({ ok: true });
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const endpoint = String((req.body as { endpoint?: string })?.endpoint || '');
    await prisma.pushSubscription.deleteMany({ where: { userId: me.id, ...(endpoint ? { endpoint } : {}) } });
    return reply.send({ ok: true });
  });

  /** Prove it works, to the device asking. */
  app.post('/api/push/test', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const sent = await sendToUser(me.id, {
      title: 'ElavoFishAI',
      body: 'Notifications are working. This is the only test you will get.',
      url: '/app',
      tag: 'test',
    });
    return reply.send({ ok: sent > 0, sent });
  });

  /**
   * Plans whose day has been and gone, that this angler asked for and has not
   * rated. This is the whole point of item one: a rating asked for under the
   * plan is asked before the trip, when nobody can answer it honestly.
   */
  app.get('/api/plans/followup', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.planRequest.findMany({
      where: {
        userId: me.id,
        skippedAt: null,
        // Yesterday or earlier, and still recent enough to remember.
        forDate: { lt: new Date(new Date().setHours(0, 0, 0, 0)), gte: new Date(Date.now() - 14 * 86400_000) },
        plan: { feedback: { none: { userId: me.id } } },
      },
      include: { plan: { select: { id: true, species: true, goal: true, date: true, lake: { select: { name: true } } } } },
      orderBy: { forDate: 'desc' },
      take: 3,
    });
    return {
      followups: rows.map((r) => ({
        planId: r.plan.id,
        requestId: r.id,
        lake: r.plan.lake?.name || 'your lake',
        species: r.plan.species,
        goal: r.plan.goal,
        date: r.plan.date,
      })),
    };
  });

  /** "I didn't go" — an honest answer, and a reason to stop asking. */
  app.post('/api/plans/followup/:id/skip', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.planRequest.updateMany({
      where: { id: String((req.params as { id: string }).id), userId: me.id },
      data: { skippedAt: new Date() },
    });
    return reply.send({ ok: true });
  });
}

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { clientIp, currentUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';

const MAX_LEN = 2000;
const trim = (v: unknown, n = 300): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, n) : null;
};

export async function clientErrorRoutes(app: FastifyInstance): Promise<void> {
  // Report a JavaScript error from the app. Deliberately open to anonymous
  // callers — the errors worth catching are the ones that break the page
  // before anyone can sign in — but rate-limited hard, since anything
  // unauthenticated and writable is a spam target.
  app.post('/api/client-error', async (req, reply) => {
    const ip = clientIp(req);
    if (await overLimit(`clienterr:${ip}`, 20, 60_000)) {
      return reply.code(429).send({ ok: false });
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const message = trim(b.message, MAX_LEN);
    if (!message) return reply.code(400).send({ ok: false });

    const user = await currentUser(req).catch(() => null);
    await prisma.clientError
      .create({
        data: {
          message,
          source: trim(b.source),
          stack: trim(b.stack, MAX_LEN),
          url: trim(b.url, 500),
          userAgent: trim(req.headers['user-agent'], 300),
          userId: user?.id ?? null,
          ip,
        },
      })
      .catch(() => {
        /* reporting an error must never itself error out loud */
      });
    return reply.send({ ok: true });
  });
}

// Keep the table bounded — 14 days is plenty to spot a bad deploy.
export async function sweepClientErrors(): Promise<void> {
  await prisma.clientError.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 14 * 86400000) } },
  });
}

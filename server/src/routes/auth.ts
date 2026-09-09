import type { FastifyInstance } from 'fastify';
import { env } from '../env';
import { clientIp, endSession, startSession } from '../lib/auth';
import { isPrivateIp } from '../lib/net';
import { overLimit } from '../lib/rateLimit';
import { consumeMagicLink, issueMagicLink } from '../services/magicLink';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrlFor(req: { headers: Record<string, unknown>; protocol: string }): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string) || 'localhost';
  return `${proto}://${host}`;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Request a magic link — unified login + self-registration.
  app.post('/api/auth/request-link', async (req, reply) => {
    const body = (req.body || {}) as { email?: string; displayName?: string };
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'Enter a valid email address.' });
    }
    const ip = clientIp(req);
    // Rate-limit by IP and by email so neither can be abused.
    if (await overLimit(`magiclink:ip:${ip}`, 10, 15 * 60000)) {
      return reply.code(429).send({ error: 'Too many requests. Try again in a bit.' });
    }
    if (await overLimit(`magiclink:email:${email}`, 5, 15 * 60000)) {
      return reply.code(429).send({ error: 'Too many links sent to that email. Check your inbox.' });
    }

    const link = await issueMagicLink(email, body.displayName, ip, baseUrlFor(req));

    // With email configured the response says nothing beyond "check your inbox".
    const payload: Record<string, unknown> = {
      ok: true,
      purpose: link.purpose,
      message:
        link.purpose === 'signup'
          ? 'Check your email to finish creating your account.'
          : 'Check your email for your sign-in link.',
    };
    // Only surface the link in-app when we did NOT email it (dev/console mode),
    // and only to a caller on the local network — otherwise handing back the
    // link would let anyone on the internet sign in as any address they type.
    if (!link.emailed && env.devShowMagicLink) {
      if (isPrivateIp(ip)) {
        payload.devLink = link.url;
      } else {
        req.log.warn({ ip }, 'dev magic-link withheld from a non-private client');
        payload.message = 'Email delivery is not configured yet. Ask an admin for your sign-in link.';
      }
    }
    return reply.send(payload);
  });

  // Verify a magic link → start a session and land on the app.
  app.get('/api/auth/verify', async (req, reply) => {
    const token = String((req.query as { token?: string }).token || '');
    const result = await consumeMagicLink(token, clientIp(req));
    if (!result.ok || !result.userId) {
      // Bounce back to the app with an error the UI can show.
      const msg = encodeURIComponent(result.error || 'This link is invalid.');
      return reply.redirect(`/app?auth_error=${msg}`);
    }
    await startSession(reply, req, result.userId);
    return reply.redirect('/app?signed_in=1');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(req, reply);
    return reply.send({ ok: true, user: null });
  });
}

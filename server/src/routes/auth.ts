import type { FastifyInstance } from 'fastify';
import { env } from '../env';
import { clientIp, endSession, startSession } from '../lib/auth';
import { isPrivateIp } from '../lib/net';
import { overLimit } from '../lib/rateLimit';
import { redeemInvites } from './invites';
import { emailConfigured } from '../services/email';
import { consumeMagicLink, issueMagicLink } from '../services/magicLink';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Where a link we email should point.
 *
 * A magic link carries a credential, so the address in it must never come
 * from a header the caller controls: "Host: evil.example" would have us email
 * the user a working sign-in token pointing at someone else's server. When
 * PUBLIC_BASE_URL is configured — which production requires, see env.ts — it
 * is the only thing used. The header fallback survives for local development,
 * where the host is a loopback address anyway.
 */
export function baseUrlFor(req: { headers: Record<string, unknown>; protocol: string }): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string) || 'localhost';
  return `${proto}://${host}`;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Request a magic link — unified login + self-registration.
  app.post('/api/auth/request-link', async (req, reply) => {
    const body = (req.body || {}) as { email?: string; displayName?: string; invite?: string };
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

    const link = await issueMagicLink(email, body.displayName, ip, baseUrlFor(req), String(body.invite || '').slice(0, 64) || undefined);

    // With email configured the response says nothing beyond "check your inbox".
    // The same answer whichever it was: telling an anonymous caller whether an
    // address already has an account turns this into an account checker.
    const payload: Record<string, unknown> = {
      ok: true,
      purpose: link.purpose,
      message: 'Check your email — your link is on its way.',
    };

    // Only surface the link in-app when we did NOT email it (dev/console mode),
    // and only to a caller on the local network — otherwise handing back the
    // link would let anyone on the internet sign in as any address they type.
    const devLinkOk = !link.emailed && env.devShowMagicLink && isPrivateIp(ip);
    if (devLinkOk) payload.devLink = link.url;

    // Nothing was emailed and nothing can be shown: say so instead of telling
    // someone to check an inbox that will never receive anything.
    if (!link.emailed && !devLinkOk) {
      req.log.error(
        { email, configured: emailConfigured(), reason: link.deliveryError },
        'sign-in link could not be delivered'
      );
      return reply.code(503).send({
        error: emailConfigured()
          ? "We couldn't send your sign-in link just now. Please try again in a minute — if it keeps failing, contact support."
          : 'Sign-in email is not configured on this server yet. Ask an admin for a sign-in link.',
      });
    }
    return reply.send(payload);
  });

  // Verify a magic link → start a session and land on the app.
  app.get('/api/auth/verify', async (req, reply) => {
    const token = String((req.query as { token?: string }).token || '');
    const result = await consumeMagicLink(token, clientIp(req));
    if (!result.ok || !result.userId) {
      // Bounce back to the app with an error the UI can show.
      // /app has no session at this point and bounces to /login, dropping the
      // query string — so the reason for the failure never reached anyone.
      const msg = encodeURIComponent(result.error || 'This link is invalid.');
      return reply.redirect(`/login?auth_error=${msg}`);
    }
    await startSession(reply, req, result.userId);
    // An invite sent to this address becomes a friendship the moment they
    // arrive — see redeemInvites() for why it keys off the email.
    const redeemed = await redeemInvites(result.userId, result.inviteCode || null).catch(() => 0);
    return reply.redirect(`/app?signed_in=1${redeemed ? '&invited=' + redeemed : ''}`);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(req, reply);
    return reply.send({ ok: true, user: null });
  });
}

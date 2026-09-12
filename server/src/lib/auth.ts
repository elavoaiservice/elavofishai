import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { isPrivateIp } from './net';
import { env } from '../env';
import { randomToken, sha256 } from './crypto';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  role: string;
  status: string;
}

// How long a signed-in angler stays signed in.
//
// The product promise is "signed in until you sign out", and the way to keep
// that promise is a long window that slides forward every time the app is
// used — not an infinite one. A session row that can never expire is a stolen
// cookie that works forever, and browsers cap a cookie's lifetime at 400 days
// anyway (RFC 6265bis), so "ten years" would be a lie the browser quietly
// shortens. Someone who uses the app is renewed indefinitely; someone who
// walks away is eventually forgotten.
const SESSION_MS = () => env.sessionDays * 86400000;
// Renew once the session is past its halfway point, so an active user costs
// one small write every few months rather than one on every request.
const RENEW_AFTER = 0.5;

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(env.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    maxAge: env.sessionDays * 86400,
  });
}

// Create a session, persist its hash, and set the cookie.
export async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_MS());
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    },
  });
  setSessionCookie(reply, token);
}

/** True once a session is past its halfway point and is due to be extended. */
export function needsRenewal(expiresAt: Date, windowMs = SESSION_MS(), now = Date.now()): boolean {
  const remaining = expiresAt.getTime() - now;
  if (remaining <= 0) return false; // expired is not renewable — sign in again
  return remaining < windowMs * RENEW_AFTER;
}

// Resolve the current user from the session cookie (or null).
//
// Pass `reply` wherever there is one: using the app is what slides the session
// forward, and a read that cannot set a cookie cannot renew.
export async function currentUser(req: FastifyRequest, reply?: FastifyReply): Promise<SessionUser | null> {
  const token = (req.cookies as Record<string, string | undefined>)[env.cookieName];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (reply && needsRenewal(session.expiresAt)) {
    const expiresAt = new Date(Date.now() + SESSION_MS());
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt } }).catch(() => {});
    setSessionCookie(reply, token);
  }
  const u = session.user;
  if (u.status !== 'active') return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    username: u.username,
    role: u.role,
    status: u.status,
  };
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = (req.cookies as Record<string, string | undefined>)[env.cookieName];
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } }).catch(() => {});
  }
  reply.clearCookie(env.cookieName, { path: '/' });
}

/**
 * Who is actually calling.
 *
 * This used to read the first entry of X-Forwarded-For, which is whatever the
 * caller typed. Verified against production: sending `X-Forwarded-For:
 * 1.2.3.4` from the open internet made the server log that as the client
 * address, so every per-IP rate limit — sign-in links, admin login, lake
 * search — could be bypassed by changing a header on each request.
 *
 * The rule now: proxy headers are only believed when the connection itself
 * comes from a private address, which is the only case where the proxy is
 * ours (the Cloudflare tunnel runs beside the app on the Docker network).
 * A request straight off the internet is judged by its socket address and
 * nothing else. Exported for tests.
 */
export function resolveClientIp(peer: string, headers: Record<string, unknown>): string {
  const first = (v: unknown): string => {
    const raw = Array.isArray(v) ? v[0] : v;
    return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  };
  if (!isPrivateIp(peer)) return peer;
  // Cloudflare overwrites CF-Connecting-IP at its edge, so behind the tunnel
  // it is the one header a client cannot forge.
  return first(headers['cf-connecting-ip']) || first(headers['x-forwarded-for']) || peer;
}

export function clientIp(req: FastifyRequest): string {
  // req.socket.remoteAddress is the real peer; req.ip follows trustProxy and
  // would give back the spoofable header value.
  const peer = req.socket?.remoteAddress || req.ip || '';
  return resolveClientIp(peer, req.headers as Record<string, unknown>) || peer;
}

// Route guard: returns the user or sends 401 and returns null.
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  const user = await currentUser(req, reply);
  if (!user) {
    reply.code(401).send({ error: 'Sign in first.' });
    return null;
  }
  return user;
}

// Admin guard.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'Admins only.' });
    return null;
  }
  return user;
}

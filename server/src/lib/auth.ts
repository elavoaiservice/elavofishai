import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
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

// Create a session, persist its hash, and set the cookie.
export async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.sessionDays * 86400000);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    },
  });
  reply.setCookie(env.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    maxAge: env.sessionDays * 86400,
  });
}

// Resolve the current user from the session cookie (or null).
export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
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

export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip;
}

// Route guard: returns the user or sends 401 and returns null.
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  const user = await currentUser(req);
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

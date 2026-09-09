import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { env } from '../env';
import { sha256 } from './crypto';

const ADMIN_COOKIE = 'efa_admin';
const SESSION_DAYS = 7;

function hashPassword(pw: string): Promise<string> {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, salt, 64, (e, dk) => (e ? rej(e) : res(salt + ':' + dk.toString('hex'))));
  });
}
export function verifyPassword(pw: string, stored: string): Promise<boolean> {
  return new Promise((res) => {
    const [salt, hex] = String(stored).split(':');
    if (!salt || !hex) return res(false);
    crypto.scrypt(pw, salt, 64, (e, dk) => {
      if (e) return res(false);
      try {
        res(crypto.timingSafeEqual(Buffer.from(hex, 'hex'), dk));
      } catch {
        res(false);
      }
    });
  });
}

// Seed/refresh the admin account from env (ADMIN_USERNAME/PASSWORD/EMAIL).
export async function bootstrapAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL || 'admin@elavofishai.local';
  if (!username || !password) return;
  const existing = await prisma.adminUser.findUnique({ where: { username } });
  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.adminUser.update({ where: { id: existing.id }, data: { passwordHash, email } });
  } else {
    await prisma.adminUser.create({ data: { username, passwordHash, email } });
  }
}

// Step 1: verify username+password, mint a one-time MFA code (dev-returned until email is wired).
export interface MfaChallenge { ok: boolean; code?: string; error?: string }
export async function startAdminLogin(username: string, password: string): Promise<MfaChallenge> {
  const admin = await prisma.adminUser.findUnique({ where: { username } });
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
    return { ok: false, error: 'Wrong username or password.' };
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.adminMfaCode.create({
    data: { adminId: admin.id, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60000) },
  });
  // TODO: email the code once RESEND_API_KEY is configured. Until then, dev/console mode.
  if (env.devShowMagicLink) {
    // eslint-disable-next-line no-console
    console.log(`\n[admin-mfa] code for ${username}: ${code}\n`);
  }
  return { ok: true, code: env.devShowMagicLink ? code : undefined };
}

// Step 2: verify the MFA code → start an admin session.
export async function completeAdminLogin(username: string, code: string, reply: FastifyReply): Promise<boolean> {
  const admin = await prisma.adminUser.findUnique({ where: { username } });
  if (!admin) return false;
  const rec = await prisma.adminMfaCode.findFirst({
    where: { adminId: admin.id, codeHash: sha256(code), usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) return false;
  await prisma.adminMfaCode.update({ where: { id: rec.id }, data: { usedAt: new Date() } });

  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.adminSession.create({
    data: { adminId: admin.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) },
  });
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  reply.setCookie(ADMIN_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: env.cookieSecure, maxAge: SESSION_DAYS * 86400 });
  return true;
}

export interface AdminUserView { id: string; username: string; email: string }
export async function currentAdmin(req: FastifyRequest): Promise<AdminUserView | null> {
  const token = (req.cookies as Record<string, string | undefined>)[ADMIN_COOKIE];
  if (!token) return null;
  const s = await prisma.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  return { id: s.admin.id, username: s.admin.username, email: s.admin.email };
}

export async function endAdminSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = (req.cookies as Record<string, string | undefined>)[ADMIN_COOKIE];
  if (token) await prisma.adminSession.deleteMany({ where: { tokenHash: sha256(token) } }).catch(() => {});
  reply.clearCookie(ADMIN_COOKIE, { path: '/' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<AdminUserView | null> {
  const admin = await currentAdmin(req);
  if (!admin) {
    reply.code(401).send({ error: 'Admin sign-in required.' });
    return null;
  }
  return admin;
}

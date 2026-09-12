import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { env } from '../env';
import { sha256 } from './crypto';
import { adminMfaEmail, emailConfigured, sendEmail } from '../services/email';

const ADMIN_COOKIE = 'efa_admin';
// An admin session is short and absolute: five hours from sign-in, never
// extended. The Command Center can suspend accounts, read every angler's
// details and rewrite the server's configuration, so an unattended browser is
// the thing to be afraid of — and an idle timeout that keeps sliding is no
// protection against a session left open on a desk. Signing in again takes a
// password and an emailed code, which is the point.
const SESSION_HOURS = 5;
const ADMIN_SESSION_MS = SESSION_HOURS * 3600000;

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

// Admins log in with their EMAIL address — it's the login id (stored in the
// `username` column so sessions/audit keep working) and where MFA is sent.
export async function createAdminUser(email: string, password: string) {
  const login = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  return prisma.adminUser.create({ data: { username: login, passwordHash, email: login } });
}

// Seed/refresh the seed admin from env (ADMIN_EMAIL + ADMIN_PASSWORD).
// ADMIN_USERNAME is legacy-only: it lets us migrate a pre-email-login row in place.
export async function bootstrapAdmin(): Promise<void> {
  const password = process.env.ADMIN_PASSWORD;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const legacyUsername = process.env.ADMIN_USERNAME;
  if (!password || !email) return;
  const passwordHash = await hashPassword(password);
  const existing = await prisma.adminUser.findFirst({
    where: { OR: [{ username: email }, { email }, ...(legacyUsername ? [{ username: legacyUsername }] : [])] },
  });
  if (existing) {
    await prisma.adminUser.update({ where: { id: existing.id }, data: { username: email, email, passwordHash } });
  } else {
    await prisma.adminUser.create({ data: { username: email, passwordHash, email } });
  }
}

// Step 1: verify username+password, mint a one-time MFA code (dev-returned until email is wired).
export interface MfaChallenge { ok: boolean; code?: string; error?: string }
export async function startAdminLogin(username: string, password: string): Promise<MfaChallenge> {
  const admin = await prisma.adminUser.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
    return { ok: false, error: 'Wrong username or password.' };
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // Only ever one code alive per admin. They used to accumulate: asking for
  // ten codes made ten of the million possibilities correct at once, and
  // guessing got ten times easier for every request an attacker sent.
  await prisma.adminMfaCode.updateMany({
    where: { adminId: admin.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  await prisma.adminMfaCode.create({
    data: { adminId: admin.id, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60000) },
  });
  // Email the code when Resend is configured; otherwise dev/console mode.
  let emailed = false;
  if (emailConfigured()) {
    const { subject, html } = adminMfaEmail(code);
    emailed = await sendEmail(admin.email, subject, html);
  }
  if (!emailed && env.devShowMagicLink) {
    // eslint-disable-next-line no-console
    console.log(`\n[admin-mfa] code for ${username}: ${code}\n`);
  }
  return { ok: true, code: emailed ? undefined : env.devShowMagicLink ? code : undefined };
}

// Step 2: verify the MFA code → start an admin session.
/**
 * Six digits is a million possibilities, which sounds like a lot until you
 * realise nothing was counting the guesses: an attacker with the password
 * could sit on this endpoint at a few hundred requests a second and be inside
 * within the code's ten-minute life. Five wrong answers now burns the code
 * entirely — the admin simply signs in again and gets a fresh one, which
 * costs them a moment and costs an attacker the whole attempt.
 */
const MAX_MFA_TRIES = 5;
const mfaTries = new Map<string, number>();

export async function completeAdminLogin(username: string, code: string, reply: FastifyReply): Promise<boolean> {
  const admin = await prisma.adminUser.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!admin) return false;
  const tries = (mfaTries.get(admin.id) || 0) + 1;
  if (tries > MAX_MFA_TRIES) {
    await prisma.adminMfaCode.updateMany({ where: { adminId: admin.id, usedAt: null }, data: { usedAt: new Date() } });
    mfaTries.delete(admin.id);
    return false;
  }
  mfaTries.set(admin.id, tries);
  const rec = await prisma.adminMfaCode.findFirst({
    where: { adminId: admin.id, codeHash: sha256(code), usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) return false;
  mfaTries.delete(admin.id);
  await prisma.adminMfaCode.update({ where: { id: rec.id }, data: { usedAt: new Date() } });

  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.adminSession.create({
    data: { adminId: admin.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ADMIN_SESSION_MS) },
  });
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  reply.setCookie(ADMIN_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: env.cookieSecure, maxAge: SESSION_HOURS * 3600 });
  return true;
}

export interface AdminUserView { id: string; username: string; email: string; expiresAt?: Date }
export { SESSION_HOURS as ADMIN_SESSION_HOURS, ADMIN_SESSION_MS };
export async function currentAdmin(req: FastifyRequest): Promise<AdminUserView | null> {
  const token = (req.cookies as Record<string, string | undefined>)[ADMIN_COOKIE];
  if (!token) return null;
  const s = await prisma.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    // Clear it out rather than leaving a dead row to be swept later; the next
    // request should look exactly like a fresh, signed-out browser.
    await prisma.adminSession.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  return { id: s.admin.id, username: s.admin.username, email: s.admin.email, expiresAt: s.expiresAt };
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

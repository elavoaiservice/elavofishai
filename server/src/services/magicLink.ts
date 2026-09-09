import { prisma } from '../db';
import { env } from '../env';
import { randomToken, sha256 } from '../lib/crypto';
import { emailConfigured, emailStatus, magicLinkEmail, sendEmail } from './email';
import { defaultMessagePrivacy } from '../config-store';

export interface IssuedLink {
  url: string;
  purpose: 'login' | 'signup';
  expiresAt: Date;
  emailed: boolean;
  /** Why delivery didn't happen, when it didn't. */
  deliveryError?: string;
}

// Issue a magic link for an email. Unified login+signup: if the email already
// has an account it's a login link, otherwise a signup link (displayName captured).
export async function issueMagicLink(
  email: string,
  displayName: string | undefined,
  ip: string,
  baseUrl: string
): Promise<IssuedLink> {
  const existing = await prisma.user.findUnique({ where: { email } });
  const purpose: 'login' | 'signup' = existing ? 'login' : 'signup';

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.magicLinkTtlMin * 60000);
  await prisma.authToken.create({
    data: {
      email,
      tokenHash: sha256(token),
      purpose,
      displayName: existing ? null : (displayName || email.split('@')[0]),
      expiresAt,
      ip,
    },
  });

  const url = `${baseUrl.replace(/\/$/, '')}/api/auth/verify?token=${token}`;

  // Send a real email when Resend is configured; otherwise dev/console mode.
  let emailed = false;
  let deliveryError: string | undefined;
  if (emailConfigured()) {
    const { subject, html } = magicLinkEmail(url, purpose);
    emailed = await sendEmail(email, subject, html);
    if (!emailed) deliveryError = emailStatus().lastError || 'send failed';
  } else {
    deliveryError = 'no email provider configured';
  }
  if (!emailed && env.devShowMagicLink) {
    // eslint-disable-next-line no-console
    console.log(`\n[magic-link] ${purpose} for ${email}\n  ${url}\n`);
  }
  return { url, purpose, expiresAt, emailed, deliveryError };
}

export interface ConsumeResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

// Consume a token: validate, mark used, find-or-create the user. One-time use.
export async function consumeMagicLink(rawToken: string, ip: string): Promise<ConsumeResult> {
  if (!rawToken) return { ok: false, error: 'Missing token.' };
  const tokenHash = sha256(rawToken);
  const rec = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!rec) return { ok: false, error: 'This link is invalid.' };
  if (rec.usedAt) return { ok: false, error: 'This link was already used.' };
  if (rec.expiresAt.getTime() < Date.now()) return { ok: false, error: 'This link has expired.' };

  // Mark used first (one-time), then resolve the user.
  await prisma.authToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });

  let user = await prisma.user.findUnique({ where: { email: rec.email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: rec.email,
        displayName: rec.displayName || rec.email.split('@')[0],
        messagePrivacy: defaultMessagePrivacy(),
      },
    });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { ok: true, userId: user.id };
}

// Best-effort sweep of expired/used tokens.
export async function sweepAuthTokens(): Promise<void> {
  await prisma.authToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] },
  });
}

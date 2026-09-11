import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { currentUser, requireUser } from '../lib/auth';
import { areFriends, blockState } from '../lib/social';
import { MESSAGE_PRIVACY_CHOICES } from '../config-store';

// Bump when the terms change materially, so acceptance records stay meaningful.
export const TERMS_VERSION = '2026-09-09';

// Max size of a stored avatar data URL (client resizes to a small square first).
const MAX_AVATAR_CHARS = 400_000; // ~300KB binary

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Never errors for anonymous users. `user` stays a string (or null) for
  // backward-compat with the existing frontend; `account` carries the full record.
  app.get('/api/me', async (req, reply) => {
    // The app asks this on every load, which makes it the natural place for a
    // session to slide forward — see currentUser().
    const u = await currentUser(req, reply);
    return {
      user: u ? (u.displayName || u.username || u.email) : null,
      inviteRequired: false,
      account: u
        ? { id: u.id, email: u.email, displayName: u.displayName, username: u.username, role: u.role }
        : null,
    };
  });

  // ---- own profile (editable) ----
  app.get('/api/me/profile', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const u = await prisma.user.findUnique({
      where: { id: me.id },
      select: {
        id: true, email: true, displayName: true, username: true, avatarUrl: true,
        location: true, bio: true, favoriteSpecies: true, favoriteLakeId: true,
        favoriteLure: true, hasBoat: true, boatType: true, yearsFishing: true, onboardedAt: true,
        plotterBrand: true, ffsBrand: true, discoverability: true,
        termsAcceptedAt: true, termsVersion: true,
        favoriteLake: { select: { id: true, name: true, region: true } },
        messagePrivacy: true, createdAt: true,
      },
    });
    return { profile: u };
  });

  app.patch('/api/me/profile', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    if (typeof b.displayName === 'string') {
      const dn = b.displayName.trim().slice(0, 60);
      if (!dn) return reply.code(400).send({ error: 'Display name cannot be empty.' });
      data.displayName = dn;
    }
    if ('location' in b) data.location = String(b.location || '').trim().slice(0, 120) || null;
    if ('bio' in b) data.bio = String(b.bio || '').trim().slice(0, 600) || null;
    if ('favoriteSpecies' in b) data.favoriteSpecies = String(b.favoriteSpecies || '').trim().slice(0, 60) || null;
    if ('favoriteLure' in b) data.favoriteLure = String(b.favoriteLure || '').trim().slice(0, 80) || null;
    if ('plotterBrand' in b) data.plotterBrand = String(b.plotterBrand || '').trim().slice(0, 20) || null;
    if ('ffsBrand' in b) data.ffsBrand = String(b.ffsBrand || '').trim().slice(0, 20) || null;
    if ('yearsFishing' in b) data.yearsFishing = String(b.yearsFishing || '').trim().slice(0, 40) || null;
    if ('hasBoat' in b) data.hasBoat = b.hasBoat == null ? null : !!b.hasBoat;
    if ('boatType' in b) data.boatType = String(b.boatType || '').trim().slice(0, 40) || null;
    // Set once, when the first-run flow finishes — never unset from the client.
    if (b.onboarded === true) {
      data.onboardedAt = new Date();
      // The sign-up screen states the terms; completing first run records that
      // acceptance against a version, so "they agreed" can be evidenced.
      data.termsAcceptedAt = new Date();
      data.termsVersion = TERMS_VERSION;
    }

    if ('favoriteLakeId' in b) {
      const id = b.favoriteLakeId ? String(b.favoriteLakeId) : null;
      if (id) {
        const lake = await prisma.lake.findUnique({ where: { id }, select: { id: true } });
        if (!lake) return reply.code(400).send({ error: 'Unknown lake.' });
      }
      data.favoriteLakeId = id;
    }

    if ('avatarUrl' in b) {
      const a = b.avatarUrl == null ? null : String(b.avatarUrl);
      if (a) {
        if (a.length > MAX_AVATAR_CHARS) return reply.code(413).send({ error: 'Image too large — pick a smaller photo.' });
        if (!/^data:image\/(png|jpe?g|webp);base64,/.test(a) && !/^https?:\/\//.test(a)) {
          return reply.code(400).send({ error: 'Invalid image.' });
        }
      }
      data.avatarUrl = a;
    }

    if ('discoverability' in b) {
      const d = String(b.discoverability || '').toLowerCase();
      if (!['everyone', 'friends_of_friends', 'nobody'].includes(d)) {
        return reply.code(400).send({ error: 'Invalid discoverability setting.' });
      }
      data.discoverability = d;
    }

    if ('messagePrivacy' in b) {
      const mp = String(b.messagePrivacy || '').toLowerCase();
      if (!MESSAGE_PRIVACY_CHOICES.includes(mp)) return reply.code(400).send({ error: 'Invalid message setting.' });
      data.messagePrivacy = mp;
    }

    if (Object.keys(data).length === 0) return reply.send({ ok: true });
    await prisma.user.update({ where: { id: me.id }, data });
    return reply.send({ ok: true });
  });

  // ---- another angler's public profile ----
  app.get('/api/users/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const u = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, displayName: true, username: true, avatarUrl: true,
        location: true, bio: true, favoriteSpecies: true, messagePrivacy: true,
        favoriteLure: true, hasBoat: true, boatType: true, yearsFishing: true, onboardedAt: true,
        plotterBrand: true, ffsBrand: true, discoverability: true,
        termsAcceptedAt: true, termsVersion: true,
        favoriteLake: { select: { id: true, name: true, region: true } },
        createdAt: true,
      },
    });
    if (!u) return reply.code(404).send({ error: 'Angler not found.' });
    // Either direction of a block hides the profile, and says no more than
    // "not found" so a block can't be probed for.
    if ((await blockState(me.id, u.id)) !== 'none') {
      return reply.code(404).send({ error: 'Angler not found.' });
    }
    const friends = await areFriends(me.id, u.id);
    const canMessage = me.id !== u.id &&
      (u.messagePrivacy === 'everyone' || (u.messagePrivacy !== 'nobody' && friends));
    return {
      profile: {
        id: u.id, displayName: u.displayName, username: u.username, avatarUrl: u.avatarUrl,
        location: u.location, bio: u.bio, favoriteSpecies: u.favoriteSpecies,
        favoriteLure: u.favoriteLure, hasBoat: u.hasBoat, boatType: u.boatType,
        plotterBrand: u.plotterBrand, ffsBrand: u.ffsBrand,
        yearsFishing: u.yearsFishing,
        favoriteLake: u.favoriteLake, createdAt: u.createdAt,
        email: friends ? u.email : undefined, // email only visible to friends
      },
      isFriend: friends,
      isSelf: me.id === u.id,
      canMessage,
    };
  });
}

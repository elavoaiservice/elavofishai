/**
 * Catch photos: upload, and serve with the catch's own visibility enforced.
 *
 * Every read goes through here rather than a public or presigned URL. A signed
 * link cannot be revoked once it exists, so "friends only" would quietly become
 * "anyone with the link" the first time someone forwarded it.
 */
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { areFriends, blockState } from '../lib/social';
import { deleteObject, getObject, putObject, storageConfigured } from '../services/storage';

// The client resizes before upload (which also strips EXIF — phone photos carry
// GPS, and a shared photo must not leak the spot the visibility settings
// protect). This is the backstop.
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function photoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/photos/status', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { configured: storageConfigured() };
  });

  // Upload a photo. It arrives unattached; the catch it belongs to is set when
  // the catch is saved, so an abandoned form leaves an orphan we can sweep
  // rather than a broken catch.
  app.post('/api/photos', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!storageConfigured()) return reply.code(503).send({ error: 'Photo storage is not configured yet.' });
    if (await overLimit(`photo:${me.id}`, 60, 3600_000)) {
      return reply.code(429).send({ error: 'That is a lot of photos this hour — try again later.' });
    }

    const b = (req.body || {}) as { image?: string; lakeId?: string; width?: number; height?: number };
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.image || ''));
    if (!m) return reply.code(400).send({ error: 'Send a JPEG, PNG or WebP photo.' });
    const mediaType = m[1];
    if (!ALLOWED.has(mediaType)) return reply.code(400).send({ error: 'Unsupported image type.' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_BYTES) return reply.code(413).send({ error: 'Photo too large — it should resize before upload.' });

    const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
    const key = `catch/${me.id}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    try {
      await putObject(key, bytes, mediaType);
    } catch (e) {
      req.log.error({ err: e }, 'photo upload failed');
      return reply.code(502).send({ error: 'Could not store that photo — try again.' });
    }

    const photo = await prisma.photo.create({
      data: {
        key, userId: me.id, mediaType, bytes: bytes.length,
        lakeId: b.lakeId ? String(b.lakeId) : null,
        width: Number.isFinite(b.width) ? Number(b.width) : null,
        height: Number.isFinite(b.height) ? Number(b.height) : null,
      },
    });
    return reply.send({ photo: { id: photo.id, url: `/api/photos/${photo.id}` } });
  });

  // Serve a photo, enforcing the visibility of the catch it belongs to.
  app.get('/api/photos/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const photo = await prisma.photo.findUnique({
      where: { id: String((req.params as { id: string }).id) },
      include: { trip: { select: { userId: true, visibility: true, groupId: true } } },
    });
    if (!photo) return reply.code(404).send({ error: 'No such photo.' });

    const mine = photo.userId === me.id;
    if (!mine) {
      // Blocked either way: the photo does not exist as far as they're concerned.
      if ((await blockState(me.id, photo.userId)) !== 'none') return reply.code(404).send({ error: 'No such photo.' });
      const trip = photo.trip;
      // An unattached photo is private to its owner until a catch gives it a
      // visibility — the safe default while a form is half-filled.
      if (!trip) return reply.code(403).send({ error: 'Not your photo.' });
      const allowed =
        trip.visibility === 'public' ||
        (trip.visibility === 'friends' && (await areFriends(me.id, photo.userId))) ||
        (trip.visibility === 'group' && trip.groupId
          ? !!(await prisma.friendGroupMember.findFirst({ where: { groupId: trip.groupId, memberId: me.id } })) ||
            !!(await prisma.friendGroup.findFirst({ where: { id: trip.groupId, ownerId: me.id } }))
          : false);
      if (!allowed) return reply.code(403).send({ error: 'Not shared with you.' });
    }

    const obj = await getObject(photo.key);
    if (!obj) return reply.code(404).send({ error: 'Photo is missing from storage.' });
    reply.header('Content-Type', obj.contentType || photo.mediaType);
    // Private: caches must not hold a photo that visibility might later revoke.
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(obj.body);
  });

  app.delete('/api/photos/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const photo = await prisma.photo.findFirst({ where: { id, userId: me.id } });
    if (!photo) return reply.code(404).send({ error: 'No such photo.' });
    await deleteObject(photo.key);
    await prisma.photo.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}

/** Orphans: uploaded, never attached to a catch. Swept after a day. */
export async function sweepOrphanPhotos(): Promise<void> {
  const orphans = await prisma.photo.findMany({
    where: { tripId: null, createdAt: { lt: new Date(Date.now() - 86400000) } },
    select: { id: true, key: true },
    take: 200,
  });
  for (const o of orphans) {
    await deleteObject(o.key);
    await prisma.photo.delete({ where: { id: o.id } }).catch(() => {});
  }
}

/**
 * Group tournaments.
 *
 * A club event, not a scoring engine: the host sets out what, where and when,
 * members say whether they are fishing it, and the results are settled at the
 * ramp the way they always have been. A leaderboard nobody trusts is worse
 * than no leaderboard, and weights typed into a phone are not weighed fish.
 *
 * Everything here is inside a group. Reading takes membership; hosting takes
 * the owner or an editor.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { canModerate, roleIn } from '../lib/groups';
import { notify } from '../services/notify';

export const FORMATS = ['heaviest_bag', 'biggest_fish', 'most_fish', 'other'] as const;
export const RSVP = ['in', 'out', 'maybe'] as const;

/** A date that is really a date, and an end that is really after the start. */
export function parseWindow(startsAt: unknown, endsAt: unknown): { startsAt: Date; endsAt: Date } | { error: string } {
  const start = new Date(String(startsAt || ''));
  if (isNaN(start.getTime())) return { error: 'Give the tournament a start date and time.' };
  const end = endsAt ? new Date(String(endsAt)) : new Date(start.getTime() + 8 * 3600000);
  if (isNaN(end.getTime())) return { error: 'That finish time does not look like a date.' };
  if (end.getTime() <= start.getTime()) return { error: 'It has to finish after it starts.' };
  if (end.getTime() - start.getTime() > 30 * 86400000) return { error: 'That is longer than a month — split it into events.' };
  return { startsAt: start, endsAt: end };
}

function shape(
  t: {
    id: string; name: string; details: string | null; meetAt: string | null; startsAt: Date; endsAt: Date;
    species: string | null; format: string; entryFee: string | null; status: string; hostId: string;
    host: { id: string; displayName: string; avatarUrl: string | null };
    lake: { id: string; name: string } | null;
    entries: { userId: string; status: string; note: string | null; user: { id: string; displayName: string; avatarUrl: string | null } }[];
  },
  meId: string
) {
  const mine = t.entries.find((e) => e.userId === meId);
  return {
    id: t.id,
    name: t.name,
    details: t.details,
    meetAt: t.meetAt,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    species: t.species,
    format: t.format,
    entryFee: t.entryFee,
    status: t.status,
    host: t.host,
    lake: t.lake,
    isHost: t.hostId === meId,
    myStatus: mine ? mine.status : null,
    resultsNote: (t as { resultsNote?: string | null }).resultsNote ?? null,
    entered: (t as { _count?: { catches: number } })._count?.catches ?? 0,
    counts: {
      in: t.entries.filter((e) => e.status === 'in').length,
      out: t.entries.filter((e) => e.status === 'out').length,
      maybe: t.entries.filter((e) => e.status === 'maybe').length,
      waiting: t.entries.filter((e) => e.status === 'invited').length,
    },
    entries: t.entries.map((e) => ({ user: e.user, status: e.status, note: e.note })),
  };
}

const INCLUDE = {
  _count: { select: { catches: true } },
  host: { select: { id: true, displayName: true, avatarUrl: true } },
  lake: { select: { id: true, name: true } },
  entries: {
    include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

/** Used by the group page so a member sees the events without a second call. */
export async function tournamentsForGroup(groupId: string, meId: string) {
  const rows = await prisma.tournament.findMany({
    where: { groupId, OR: [{ endsAt: { gte: new Date(Date.now() - 30 * 86400000) } }, { status: 'open' }] },
    include: INCLUDE,
    orderBy: { startsAt: 'asc' },
    take: 20,
  });
  return rows.map((t) => shape(t, meId));
}

/**
 * May this catch be entered in this tournament? Right lake, inside the window,
 * tournament still open, and the angler said they were fishing it. Anything
 * else and the board would show a fish that does not belong on it.
 */
export async function eligibleForTournament(
  userId: string,
  tournamentId: string,
  lakeId: string,
  caughtAt: Date
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { lakeId: true, startsAt: true, endsAt: true, status: true, entries: { where: { userId }, select: { status: true } } },
  });
  if (!t) return { ok: false, reason: 'No such tournament.' };
  if (t.status !== 'open') return { ok: false, reason: 'That tournament is closed.' };
  if (t.lakeId && t.lakeId !== lakeId) return { ok: false, reason: 'That tournament is on a different lake.' };
  const at = caughtAt.getTime();
  // A little slack either side: people log at the ramp, not at the moment of the hookset.
  if (at < t.startsAt.getTime() - 3600000 || at > t.endsAt.getTime() + 3 * 3600000) {
    return { ok: false, reason: 'That catch is outside the tournament hours.' };
  }
  if (t.entries[0]?.status !== 'in') return { ok: false, reason: "You haven't said you're fishing this tournament." };
  return { ok: true };
}

/**
 * The board, computed from entered catches. Three formats, three sums:
 *   heaviest_bag — the angler's five heaviest fish, added up
 *   biggest_fish — their single heaviest
 *   most_fish    — how many they entered
 * Weight is what people entered; nothing here was weighed by us, and the UI
 * says so.
 */
export async function resultsFor(tournamentId: string) {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { format: true, species: true, status: true, resultsNote: true },
  });
  if (!t) return null;
  const catches = await prisma.trip.findMany({
    where: { tournamentId },
    select: { id: true, userId: true, species: true, weight: true, length: true, date: true, user: { select: { id: true, displayName: true, avatarUrl: true } }, photos: { select: { id: true } } },
    orderBy: { date: 'asc' },
  });
  const byUser = new Map<string, typeof catches>();
  for (const c of catches) {
    if (!byUser.has(c.userId)) byUser.set(c.userId, []);
    byUser.get(c.userId)!.push(c);
  }
  const rows = [...byUser.entries()].map(([userId, list]) => {
    const weights = list.map((c) => c.weight || 0).sort((a, b) => b - a);
    const bag = weights.slice(0, 5).reduce((a, b) => a + b, 0);
    const big = weights[0] || 0;
    const score = t.format === 'biggest_fish' ? big : t.format === 'most_fish' ? list.length : bag;
    return {
      user: list[0].user,
      fish: list.length,
      bagLb: Math.round(bag * 100) / 100,
      bigLb: Math.round(big * 100) / 100,
      score: Math.round(score * 100) / 100,
      catches: list.map((c) => ({ id: c.id, species: c.species, weight: c.weight, length: c.length, date: c.date, photos: c.photos.map((p) => p.id) })),
    };
  });
  rows.sort((a, b) => b.score - a.score || b.bigLb - a.bigLb);
  return { format: t.format, species: t.species, status: t.status, resultsNote: t.resultsNote, rows };
}

export async function tournamentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Open tournaments on this lake that the angler is fishing — what the catch
   * form offers as "enter this in…".
   */
  app.get('/api/tournaments/active', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.query as { lakeId?: string }).lakeId || '');
    const now = new Date();
    const rows = await prisma.tournament.findMany({
      where: {
        status: 'open',
        startsAt: { lte: new Date(now.getTime() + 3600000) },
        endsAt: { gte: new Date(now.getTime() - 3 * 3600000) },
        ...(lakeId ? { OR: [{ lakeId }, { lakeId: null }] } : {}),
        entries: { some: { userId: me.id, status: 'in' } },
      },
      select: { id: true, name: true, species: true, format: true, endsAt: true, group: { select: { name: true } } },
      orderBy: { endsAt: 'asc' },
    });
    return { tournaments: rows.map((t) => ({ id: t.id, name: t.name, species: t.species, format: t.format, endsAt: t.endsAt, group: t.group.name })) };
  });

  app.get('/api/tournaments/:id/results', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const t = await prisma.tournament.findUnique({ where: { id }, select: { groupId: true } });
    if (!t) return reply.code(404).send({ error: 'No such tournament.' });
    if (!(await roleIn(t.groupId, me.id))) return reply.code(404).send({ error: 'No such tournament.' });
    return { results: await resultsFor(id) };
  });

  /** Every tournament this angler has been asked about, across their groups. */
  app.get('/api/tournaments', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.tournament.findMany({
      where: {
        status: 'open',
        endsAt: { gte: new Date() },
        OR: [{ hostId: me.id }, { entries: { some: { userId: me.id } } }],
      },
      include: { ...INCLUDE, group: { select: { id: true, name: true } } },
      orderBy: { startsAt: 'asc' },
      take: 30,
    });
    return {
      tournaments: rows.map((t) => ({ ...shape(t, me.id), group: t.group })),
    };
  });

  app.post('/api/groups/:id/tournaments', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groupId = String((req.params as { id: string }).id);
    const role = await roleIn(groupId, me.id);
    if (!role) return reply.code(404).send({ error: 'No such group.' });
    if (!canModerate(role)) return reply.code(403).send({ error: 'Only the owner or an editor can set up a tournament.' });

    const b = (req.body || {}) as Record<string, unknown>;
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return reply.code(400).send({ error: 'Give the tournament a name.' });
    const win = parseWindow(b.startsAt, b.endsAt);
    if ('error' in win) return reply.code(400).send({ error: win.error });
    const format = FORMATS.includes(String(b.format) as (typeof FORMATS)[number]) ? String(b.format) : 'heaviest_bag';

    const t = await prisma.tournament.create({
      data: {
        groupId,
        hostId: me.id,
        name,
        details: b.details ? String(b.details).slice(0, 4000) : null,
        lakeId: b.lakeId ? String(b.lakeId) : null,
        meetAt: b.meetAt ? String(b.meetAt).slice(0, 200) : null,
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        species: b.species ? String(b.species).slice(0, 80) : null,
        format,
        entryFee: b.entryFee ? String(b.entryFee).slice(0, 80) : null,
      },
    });

    // Invite the whole group unless the host named people. Everyone active in
    // the group, host included — the host answering their own invitation is
    // how the count stays honest.
    const asked = Array.isArray(b.userIds) ? b.userIds.map(String) : null;
    const invited = await inviteToTournament(t.id, groupId, me.id, asked);
    return reply.send({ tournament: { id: t.id }, invited });
  });

  app.put('/api/tournaments/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const t = await prisma.tournament.findUnique({ where: { id }, select: { groupId: true, hostId: true, name: true } });
    if (!t) return reply.code(404).send({ error: 'No such tournament.' });
    const role = await roleIn(t.groupId, me.id);
    if (t.hostId !== me.id && !canModerate(role)) return reply.code(403).send({ error: 'Not yours to change.' });

    const b = (req.body || {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (typeof b.name === 'string' && b.name.trim()) data.name = b.name.trim().slice(0, 120);
    if (typeof b.details === 'string') data.details = b.details.slice(0, 4000) || null;
    if (typeof b.meetAt === 'string') data.meetAt = b.meetAt.slice(0, 200) || null;
    if (typeof b.species === 'string') data.species = b.species.slice(0, 80) || null;
    if (typeof b.entryFee === 'string') data.entryFee = b.entryFee.slice(0, 80) || null;
    if (typeof b.format === 'string' && FORMATS.includes(b.format as (typeof FORMATS)[number])) data.format = b.format;
    if (typeof b.status === 'string' && ['open', 'cancelled', 'done'].includes(b.status)) data.status = b.status;
    if (typeof b.resultsNote === 'string') data.resultsNote = b.resultsNote.slice(0, 2000) || null;
    if (b.startsAt || b.endsAt) {
      const current = await prisma.tournament.findUniqueOrThrow({ where: { id }, select: { startsAt: true, endsAt: true } });
      const win = parseWindow(b.startsAt || current.startsAt, b.endsAt || current.endsAt);
      if ('error' in win) return reply.code(400).send({ error: win.error });
      data.startsAt = win.startsAt;
      data.endsAt = win.endsAt;
    }
    const updated = await prisma.tournament.update({ where: { id }, data });

    // Everyone who said they were fishing it needs to know it moved or was
    // called off — silence here is how someone drives to a cancelled event.
    if (data.status === 'cancelled' || data.status === 'done' || data.startsAt || data.endsAt) {
      const entries = await prisma.tournamentEntry.findMany({
        where: { tournamentId: id, status: { in: ['in', 'maybe', 'invited'] } },
        select: { userId: true },
      });
      for (const e of entries) {
        if (e.userId === me.id) continue;
        await notify({
          userId: e.userId,
          actorId: me.id,
          type: 'tournament_changed',
          groupId: t.groupId,
          tournamentId: id,
          snippet: `${updated.name} — ${data.status === 'cancelled' ? 'cancelled' : data.status === 'done' ? 'results are in' : 'the time changed'}`,
        });
      }
    }
    return reply.send({ ok: true });
  });

  app.delete('/api/tournaments/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const t = await prisma.tournament.findUnique({ where: { id }, select: { groupId: true, hostId: true } });
    if (!t) return reply.code(404).send({ error: 'No such tournament.' });
    const role = await roleIn(t.groupId, me.id);
    if (t.hostId !== me.id && !canModerate(role)) return reply.code(403).send({ error: 'Not yours to remove.' });
    await prisma.tournament.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  /** Ask more people — or the whole group again after new members joined. */
  app.post('/api/tournaments/:id/invite', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const t = await prisma.tournament.findUnique({ where: { id }, select: { groupId: true, hostId: true } });
    if (!t) return reply.code(404).send({ error: 'No such tournament.' });
    const role = await roleIn(t.groupId, me.id);
    if (t.hostId !== me.id && !canModerate(role)) return reply.code(403).send({ error: 'Not yours to invite to.' });
    const b = (req.body || {}) as { userIds?: unknown };
    const asked = Array.isArray(b.userIds) ? b.userIds.map(String) : null;
    const invited = await inviteToTournament(id, t.groupId, me.id, asked);
    return reply.send({ ok: true, invited });
  });

  /** "I'm fishing it", "I'm not", or an honest "maybe". */
  app.post('/api/tournaments/:id/rsvp', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const status = String((req.body as { status?: string }).status || '');
    if (!RSVP.includes(status as (typeof RSVP)[number])) {
      return reply.code(400).send({ error: "Say whether you're in, out, or a maybe." });
    }
    const t = await prisma.tournament.findUnique({ where: { id }, select: { groupId: true, hostId: true, name: true, status: true } });
    if (!t) return reply.code(404).send({ error: 'No such tournament.' });
    // Membership, not an invitation, is what lets you answer: a member who
    // joined after the invites went out can still put their name down.
    if (!(await roleIn(t.groupId, me.id))) return reply.code(403).send({ error: 'This is a group tournament.' });
    if (t.status !== 'open') return reply.code(409).send({ error: 'That tournament is closed.' });

    const note = String((req.body as { note?: string }).note || '').trim().slice(0, 200) || null;
    await prisma.tournamentEntry.upsert({
      where: { tournamentId_userId: { tournamentId: id, userId: me.id } },
      create: { tournamentId: id, userId: me.id, status, note, respondedAt: new Date() },
      update: { status, note, respondedAt: new Date() },
    });
    await notify({
      userId: t.hostId,
      actorId: me.id,
      type: 'tournament_rsvp',
      groupId: t.groupId,
      tournamentId: id,
      snippet: `${t.name} — ${status === 'in' ? 'fishing it' : status === 'out' ? 'not fishing it' : 'a maybe'}`,
    });
    return reply.send({ ok: true, status });
  });
}

/**
 * Create the invited rows and tell those anglers. Existing answers are left
 * alone — re-inviting must not wipe an RSVP someone already gave.
 */
async function inviteToTournament(
  tournamentId: string,
  groupId: string,
  actorId: string,
  userIds: string[] | null
): Promise<number> {
  const [group, members, existing, t] = await Promise.all([
    prisma.friendGroup.findUnique({ where: { id: groupId }, select: { ownerId: true } }),
    prisma.friendGroupMember.findMany({ where: { groupId, status: 'active' }, select: { memberId: true } }),
    prisma.tournamentEntry.findMany({ where: { tournamentId }, select: { userId: true } }),
    prisma.tournament.findUnique({ where: { id: tournamentId }, select: { name: true } }),
  ]);
  if (!group || !t) return 0;
  const inGroup = new Set([group.ownerId, ...members.map((m) => m.memberId)]);
  const already = new Set(existing.map((e) => e.userId));
  // Only people actually in the group can be asked — an id from a stale page
  // must not become an invitation.
  const targets = (userIds ? userIds.filter((id) => inGroup.has(id)) : [...inGroup]).filter((id) => !already.has(id));
  if (!targets.length) return 0;

  await prisma.tournamentEntry.createMany({
    data: targets.map((userId) => ({ tournamentId, userId, status: 'invited' })),
    skipDuplicates: true,
  });
  for (const userId of targets) {
    if (userId === actorId) continue;
    await notify({ userId, actorId, type: 'tournament_invite', groupId, tournamentId, snippet: t.name });
  }
  return targets.length;
}

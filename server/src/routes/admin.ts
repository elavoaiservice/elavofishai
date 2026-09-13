import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { clientIp } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  startAdminLogin, completeAdminLogin, endAdminSession, ADMIN_SESSION_HOURS, currentAdmin, requireAdmin, createAdminUser,
  isOwner, type AdminUserView,
} from '../lib/admin-auth';

/**
 * Owner-only guard. Read access is wide on purpose — support cannot help
 * without seeing things — but anything irreversible or that changes how the
 * server runs takes an owner.
 */
async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<AdminUserView | null> {
  const admin = await requireAdmin(req, reply);
  if (!admin) return null;
  if (!isOwner(admin)) {
    reply.code(403).send({ error: 'That needs an owner account. You are signed in as support.' });
    return null;
  }
  return admin;
}

/** "Chrome on iPhone" rather than 180 characters of version numbers. */
function shortDevice(ua: string): string {
  if (!ua) return 'unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  // Order matters: Edge's user agent contains "Chrome", and Chrome's contains
  // "Safari". Most specific first, or everything reads as Chrome.
  const browser = /Edg[A-Z]?\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}

// Lightweight audit trail for admin actions (actor kept in meta.by; AuditLog.userId
// is for end-users, so we leave it null for admin-initiated events).
async function audit(by: string, action: string, target?: string, meta?: Record<string, unknown>) {
  try {
    await prisma.auditLog.create({ data: { action, target: target || null, meta: { by, ...(meta || {}) } } });
  } catch { /* never block on audit */ }
}
import { CATALOG, maskedView, setValue, testValue, loadOverlay } from '../config-store';
import { buildInfo, incomingCommits, targetVersion, versionStatus } from '../version';
import { emailStatus } from '../services/email';
import { rateFor, recalculateCosts } from '../services/aiUsage';
import { fetchSource, refreshAllSources } from '../services/reports';
import { buildIndex } from '../services/corps';
import { attachOfficialSourcesForAll } from '../services/agencySources';
import { attention, egressOk, featureCounts, funnel, latestBackup } from '../services/adminInsight';
import { deleteObject, listObjects, storageConfigured } from '../services/storage';
import { pushConfigured } from '../services/push';
import { issueMagicLink } from '../services/magicLink';
import { env } from '../env';
import {
  classifyCommits,
  COMMIT_TYPE_META,
  groupCommitsByDay,
  loadHistory,
  matchesQuery,
  MAX_SCAN,
  type RawCommit,
} from '../services/changelog';

const DEPLOY_DIR = '/deploy';
const TRIGGER = path.join(DEPLOY_DIR, 'trigger');
const LOCK = path.join(DEPLOY_DIR, 'upgrade.lock');
const LOG = path.join(DEPLOY_DIR, 'status.log');

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- auth ----
  app.post('/api/admin/login', async (req, reply) => {
    const b = (req.body || {}) as { username?: string; password?: string };
    const who = String(b.username || '').trim().toLowerCase();
    if (await overLimit(`adminlogin:${clientIp(req)}`, 10, 10 * 60000) || await overLimit(`adminlogin:user:${who}`, 10, 10 * 60000)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a few minutes.' });
    }
    const r = await startAdminLogin(String(b.username || ''), String(b.password || ''));
    if (!r.ok) return reply.code(401).send({ error: r.error });
    // devCode present only in dev/console mode (until email is configured).
    return reply.send({ ok: true, mfa: true, devCode: r.code });
  });

  app.post('/api/admin/mfa', async (req, reply) => {
    const b = (req.body || {}) as { username?: string; code?: string };
    // Keyed by username as well as address: rotating a header must not buy
    // more guesses, and neither must a botnet.
    const who = String(b.username || '').trim().toLowerCase();
    if (await overLimit(`adminmfa:${who}`, 10, 10 * 60000) || await overLimit(`adminmfa:ip:${clientIp(req)}`, 20, 10 * 60000)) {
      return reply.code(429).send({ error: 'Too many attempts. Sign in again for a new code.' });
    }
    const ok = await completeAdminLogin(who, String(b.code || ''), reply);
    if (!ok) return reply.code(401).send({ error: 'Invalid or expired code.' });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/logout', async (req, reply) => {
    await endAdminSession(req, reply);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/me', async (req) => {
    const admin = await currentAdmin(req);
    // expiresAt is sent so the console can warn before it drops you, and sign
    // you out on the dot rather than at the next failed click.
    return {
      admin: admin ? { username: admin.username, email: admin.email, role: admin.role || 'owner', owner: isOwner(admin), expiresAt: admin.expiresAt } : null,
      sessionHours: ADMIN_SESSION_HOURS,
    };
  });

  /** Everything wanting a decision. Empty when there is nothing, on purpose. */
  app.get('/api/admin/attention', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: await attention() };
  });

  /** Does the product work, and is anyone using the parts we built? */
  app.get('/api/admin/pulse', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const [steps, features, backup] = await Promise.all([funnel(), featureCounts(), Promise.resolve(latestBackup())]);
    return { funnel: steps, features, backup };
  });

  // ---- metrics ----
  app.get('/api/admin/metrics', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const now = Date.now();
    const d7 = new Date(now - 7 * 86400000);
    const d30 = new Date(now - 30 * 86400000);
    const [users, active7, active30, new7, lakes, userLakes, profiles, dayPlans, kvTotal, tripKeys, admins] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastLoginAt: { gte: d7 } } }),
      prisma.user.count({ where: { lastLoginAt: { gte: d30 } } }),
      prisma.user.count({ where: { createdAt: { gte: d7 } } }),
      prisma.lake.count(),
      prisma.userLake.count(),
      prisma.lakeProfile.count(),
      prisma.dayPlan.count(),
      prisma.kv.count(),
      prisma.kv.count({ where: { key: { endsWith: ':trips' } } }),
      prisma.adminUser.count(),
    ]);
    return { users, active7, active30, new7, lakes, userLakes, profiles, dayPlans, kvTotal, tripLogs: tripKeys, admins };
  });

  // ---- users ----
  app.get('/api/admin/users', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const qs = req.query as { q?: string; page?: string; size?: string; status?: string };
    const q = String(qs.q || '').trim();
    const size = Math.min(Math.max(Number(qs.size) || 50, 10), 200);
    const page = Math.max(Number(qs.page) || 1, 1);
    const where = {
      ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { displayName: { contains: q, mode: 'insensitive' as const } }] } : {}),
      ...(qs.status === 'deleted' ? { deletedAt: { not: null } } : qs.status ? { status: qs.status } : {}),
    };
    // The total matters as much as the rows: a list silently capped at 100 is
    // a list that stops being the list on the day you get your 101st angler.
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
        select: { id: true, email: true, displayName: true, role: true, status: true, createdAt: true, lastLoginAt: true, deletedAt: true, scheduledDeleteAt: true, _count: { select: { userLakes: true, trips: true } } },
      }),
    ]);
    return {
      users: users.map((u) => ({ ...u, lakes: u._count.userLakes, trips: u._count.trips, _count: undefined })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    };
  });

  app.post('/api/admin/users/:id/status', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const status = String((req.body as { status?: string }).status || '');
    if (!['active', 'suspended'].includes(status)) return reply.code(400).send({ error: 'Bad status.' });
    await prisma.user.update({ where: { id }, data: { status } });
    if (status === 'suspended') await prisma.session.deleteMany({ where: { userId: id } });
    // Suspending someone ends their session and locks them out; that is the
    // kind of thing a person later needs to be able to ask "who did this?"
    await audit(admin.username, 'user.status', id, { status });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const role = String((req.body as { role?: string }).role || '');
    if (!['user', 'pro', 'guide', 'admin'].includes(role)) return reply.code(400).send({ error: 'Bad role.' });
    await prisma.user.update({ where: { id }, data: { role: role as 'user' | 'pro' | 'guide' | 'admin' } });
    await audit(admin.username, 'user.role', id, { role });
    return reply.send({ ok: true });
  });

  /**
   * One angler, in full.
   *
   * The portal could list users and suspend them and nothing else, so
   * "the app lost my trip" had nowhere to be looked into. Read-only, and it
   * shows what the angler HAS rather than what they wrote: counts, lakes,
   * recent catches, groups, and whether anything they own has been reported.
   */
  app.get('/api/admin/users/:id', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, displayName: true, username: true, role: true, status: true,
        createdAt: true, lastLoginAt: true, deletedAt: true, scheduledDeleteAt: true,
        location: true, favoriteSpecies: true, hasBoat: true, boatType: true, yearsFishing: true,
        discoverability: true, messagePrivacy: true, postDefault: true, onboardedAt: true,
        termsAcceptedAt: true, avatarUrl: true,
        favoriteLake: { select: { name: true } },
      },
    });
    if (!user) return reply.code(404).send({ error: 'No such angler.' });

    const [lakes, trips, spots, waypoints, posts, photos, groups, friends, invites, plans, flagsAgainst, flagsBy, sessions, push, recentTrips] =
      await Promise.all([
        prisma.userLake.findMany({ where: { userId: id }, include: { lake: { select: { name: true, region: true } } }, take: 20 }),
        prisma.trip.count({ where: { userId: id } }),
        prisma.spot.count({ where: { userId: id } }),
        prisma.waypoint.count({ where: { userId: id } }),
        prisma.post.count({ where: { authorId: id } }),
        prisma.photo.count({ where: { userId: id } }),
        prisma.friendGroupMember.findMany({ where: { memberId: id, status: 'active' }, include: { group: { select: { name: true } } }, take: 20 }),
        prisma.friendship.count({ where: { status: 'accepted', OR: [{ userId: id }, { friendId: id }] } }),
        prisma.invite.count({ where: { inviterId: id } }),
        prisma.planRequest.count({ where: { userId: id } }),
        prisma.contentFlag.count({ where: { targetType: 'user', targetId: id } }),
        prisma.contentFlag.count({ where: { reporterId: id } }),
        prisma.session.count({ where: { userId: id, expiresAt: { gt: new Date() } } }),
        prisma.pushSubscription.count({ where: { userId: id } }),
        prisma.trip.findMany({
          where: { userId: id },
          orderBy: { date: 'desc' },
          take: 10,
          select: { date: true, species: true, weight: true, visibility: true, lake: { select: { name: true } } },
        }),
      ]);

    const owned = await prisma.friendGroup.findMany({ where: { ownerId: id }, select: { name: true }, take: 20 });
    return {
      user,
      counts: { trips, spots, waypoints, posts, photos, friends, invites, plans, sessions, push, flagsAgainst, flagsBy },
      lakes: lakes.map((l) => ({ name: l.lake.name, region: l.lake.region, home: l.isHome })),
      groups: [...owned.map((g) => ({ name: g.name, role: 'owner' })), ...groups.map((g) => ({ name: g.group.name, role: g.role }))],
      recentTrips: recentTrips.map((t) => ({ date: t.date, species: t.species, weight: t.weight, lake: t.lake?.name || null, visibility: t.visibility })),
    };
  });

  /**
   * Everything we hold about an angler, as one file.
   *
   * Needed twice: when somebody asks for their data, and before deleting them —
   * a cascade with nothing to hand back is how a support request becomes an
   * apology.
   */
  app.get('/api/admin/users/:id/export', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'No such angler.' });
    const [trips, spots, waypoints, posts, comments, kv, photos, reports, invites] = await Promise.all([
      prisma.trip.findMany({ where: { userId: id } }),
      prisma.spot.findMany({ where: { userId: id } }),
      prisma.waypoint.findMany({ where: { userId: id } }),
      prisma.post.findMany({ where: { authorId: id } }),
      prisma.postComment.findMany({ where: { authorId: id } }),
      prisma.kv.findMany({ where: { userId: id } }),
      prisma.photo.findMany({ where: { userId: id }, select: { id: true, key: true, createdAt: true, bytes: true } }),
      prisma.lakeReport.findMany({ where: { userId: id } }),
      prisma.invite.findMany({ where: { inviterId: id }, select: { email: true, createdAt: true, acceptedAt: true } }),
    ]);
    await audit(admin.username, 'user.export', id, { email: user.email });
    const { ...safe } = user;
    reply.header('Content-Disposition', `attachment; filename="elavofishai-${id}.json"`);
    return reply.send({ exportedAt: new Date().toISOString(), user: safe, trips, spots, waypoints, posts, comments, kv, photos, reports, invites });
  });

  /**
   * What this angler sees.
   *
   * Not impersonation — no session is issued and nothing can be written. It
   * assembles the same answers their own app would get: which lakes they have,
   * what their sharing settings actually mean, which groups they are in, and
   * what their feed would hold. Enough to answer "it is not working" without
   * asking somebody to photograph their phone.
   *
   * Loudly audited, because looking through someone's account is a thing that
   * should leave a mark whatever the reason.
   */
  app.get('/api/admin/users/:id/view-as', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, displayName: true, email: true, status: true, discoverability: true, messagePrivacy: true, postDefault: true, onboardedAt: true },
    });
    if (!user) return reply.code(404).send({ error: 'No such angler.' });
    await audit(admin.username, 'user.viewAs', id, { email: user.email });

    const [prefs, lakes, groups, feedCount, unreadCount, pendingInvites, followups] = await Promise.all([
      prisma.sharingPref.findMany({ where: { userId: id }, select: { dataType: true, scope: true, groupIds: true } }),
      prisma.userLake.findMany({ where: { userId: id }, include: { lake: { select: { id: true, name: true, region: true, gaugeId: true } } } }),
      prisma.friendGroupMember.findMany({ where: { memberId: id }, include: { group: { select: { name: true, dataSharing: true } } } }),
      prisma.post.count({ where: { authorId: id } }),
      prisma.notification.count({ where: { userId: id, readAt: null } }),
      prisma.friendGroupMember.count({ where: { memberId: id, status: 'pending' } }),
      prisma.planRequest.count({ where: { userId: id, skippedAt: null } }),
    ]);

    return {
      user,
      // The settings in the words the app uses, not the column values.
      sharing: prefs.map((p) => ({
        what: p.dataType,
        who: p.scope === 'none' ? 'just them' : p.scope === 'groups' ? `${p.groupIds.length} group(s)` : p.scope,
      })),
      lakes: lakes.map((l) => ({ name: l.lake.name, region: l.lake.region, home: l.isHome, hasGauge: !!l.lake.gaugeId })),
      groups: groups.map((g) => ({ name: g.group.name, role: g.role, status: g.status, sharesData: g.group.dataSharing !== 'off', theyShare: { spots: g.shareSpots, catches: g.shareCatches, waypoints: g.shareWaypoints } })),
      state: { posts: feedCount, unreadNotifications: unreadCount, groupInvitesWaiting: pendingInvites, plansAwaitingFeedback: followups },
    };
  });

  // ---- settings (config GUI) ----
  app.get('/api/admin/config', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: await maskedView(), groups: [...new Set(CATALOG.map((c) => c.group))] };
  });

  app.put('/api/admin/config', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const b = (req.body || {}) as { key?: string; value?: string };
    if (!b.key) return reply.code(400).send({ error: 'Missing key.' });
    if (b.value === '••••••••') return reply.send({ ok: true, unchanged: true }); // masked, not edited
    try {
      await setValue(b.key, String(b.value ?? ''));
      // Never the value: half of these are secrets. Who changed which key,
      // and when, is what an audit trail is for.
      await audit(admin.username, 'config.set', b.key);
      return reply.send({ ok: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/admin/config/test', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = (req.body || {}) as { key?: string; value?: string };
    if (!b.key) return reply.code(400).send({ error: 'Missing key.' });
    return reply.send(await testValue(b.key, String(b.value ?? '')));
  });

  app.post('/api/admin/config/reload', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    await loadOverlay();
    return reply.send({ ok: true });
  });

  // ---- upgrade from git (host agent writes the deploy; API just signals it) ----
  app.get('/api/admin/upgrade/status', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const configured = fs.existsSync(DEPLOY_DIR);
    let log = '';
    if (configured && fs.existsSync(LOG)) { try { log = fs.readFileSync(LOG, 'utf8').slice(-12000); } catch { log = ''; } }
    return { configured, running: fs.existsSync(LOCK), log, version: await versionStatus() };
  });

  app.post('/api/admin/upgrade', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    if (!fs.existsSync(DEPLOY_DIR)) return reply.send({ ok: false, error: 'Upgrade agent not configured (the /deploy volume is not mounted).' });
    if (fs.existsSync(LOCK)) return reply.send({ ok: false, error: 'An upgrade is already running.' });
    try {
      fs.writeFileSync(TRIGGER, new Date().toISOString());
      await audit(admin.username, 'deploy.trigger');
      return reply.send({ ok: true });
    } catch (e) {
      return reply.send({ ok: false, error: `Could not signal the upgrade agent: ${(e as Error).message}` });
    }
  });

  // ---- create / delete end-users ----
  app.post('/api/admin/users', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const b = (req.body || {}) as { email?: string; displayName?: string; role?: string };
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'A valid email is required.' });
    if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ error: 'That email already has an account.' });
    const role = ['user', 'pro', 'guide', 'admin'].includes(String(b.role)) ? (b.role as 'user' | 'pro' | 'guide' | 'admin') : 'user';
    const u = await prisma.user.create({ data: { email, displayName: String(b.displayName || email.split('@')[0]).slice(0, 80), role } });
    await audit(admin.username, 'user.create', u.id, { email });
    return reply.send({ user: { id: u.id, email: u.email, displayName: u.displayName } });
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: 'No such user.' });
    const purge = (req.query as { purge?: string }).purge === '1';

    if (purge) {
      // The real thing. Only reachable deliberately, and only for an account
      // already marked — so a mis-click can never reach it.
      if (!u.deletedAt) return reply.code(400).send({ error: 'Mark the account for deletion first, then purge it.' });
      await prisma.user.delete({ where: { id } }); // cascades sessions/lakes/trips/spots/kv/friendships
      await audit(admin.username, 'user.purge', id, { email: u.email });
      return reply.send({ ok: true, purged: true });
    }

    // Mark, sign them out, and schedule the cascade for a month's time. The
    // account stops working immediately — which is what "delete" has to mean to
    // the person who asked — while the data stays recoverable for a month.
    const scheduled = new Date(Date.now() + 30 * 86400_000);
    await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), scheduledDeleteAt: scheduled, status: 'deleted' } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await audit(admin.username, 'user.delete', id, { email: u.email, scheduledFor: scheduled.toISOString() });
    return reply.send({ ok: true, scheduledFor: scheduled.toISOString() });
  });

  /**
   * The same action across a filtered set. Every action here was one row at a
   * time, which is fine for three anglers and useless for three hundred.
   * Deliberately narrow: suspend, reactivate and export. Bulk delete is not
   * offered, because a mis-click at that scale is unrecoverable.
   */
  app.post('/api/admin/users/bulk', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const b = (req.body || {}) as { ids?: string[]; action?: string };
    const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 500) : [];
    if (!ids.length) return reply.code(400).send({ error: 'Nobody selected.' });
    if (b.action !== 'suspend' && b.action !== 'activate') {
      return reply.code(400).send({ error: 'Only suspend and reactivate can be done in bulk.' });
    }
    const status = b.action === 'suspend' ? 'suspended' : 'active';
    // Never let one click lock every admin out of their own accounts.
    const targets = await prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const safe = targets.map((t) => t.id);
    await prisma.user.updateMany({ where: { id: { in: safe } }, data: { status } });
    if (status === 'suspended') await prisma.session.deleteMany({ where: { userId: { in: safe } } });
    await audit(admin.username, `user.bulk.${b.action}`, `${safe.length} anglers`, { ids: safe.slice(0, 50) });
    return reply.send({ ok: true, changed: safe.length });
  });

  /** Changed your mind, or deleted the wrong row. */
  app.post('/api/admin/users/:id/restore', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const u = await prisma.user.findUnique({ where: { id }, select: { email: true, deletedAt: true } });
    if (!u) return reply.code(404).send({ error: 'No such angler.' });
    if (!u.deletedAt) return reply.code(400).send({ error: 'That account is not deleted.' });
    await prisma.user.update({ where: { id }, data: { deletedAt: null, scheduledDeleteAt: null, status: 'active' } });
    await audit(admin.username, 'user.restore', id, { email: u.email });
    return reply.send({ ok: true });
  });

  // ---- admin users ----
  app.get('/api/admin/admins', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const admins = await prisma.adminUser.findMany({ select: { id: true, username: true, email: true, role: true, createdAt: true, lastLoginAt: true }, orderBy: { createdAt: 'asc' } });
    return { admins, me: admin.username, owner: isOwner(admin) };
  });

  app.post('/api/admin/admins', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const b = (req.body || {}) as { password?: string; email?: string };
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'Enter a valid email address.' });
    if (String(b.password || '').length < 8) return reply.code(400).send({ error: 'Password needs at least 8 characters.' });
    if (await prisma.adminUser.findUnique({ where: { username: email } })) return reply.code(409).send({ error: 'An admin with that email already exists.' });
    const a = await createAdminUser(email, String(b.password));
    await audit(admin.username, 'admin.create', a.id, { email });
    return reply.send({ ok: true });
  });

  /**
   * Owner or support. Two rules keep this from locking everyone out: you cannot
   * demote yourself, and the last owner cannot be demoted at all.
   */
  app.post('/api/admin/admins/:id/role', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const role = String((req.body as { role?: string })?.role || '');
    if (role !== 'owner' && role !== 'support') return reply.code(400).send({ error: 'Role must be owner or support.' });
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'No such admin.' });
    if (target.username === admin.username) return reply.code(400).send({ error: "You can't change your own role — ask another owner." });
    if (role === 'support' && isOwner(target) && (await prisma.adminUser.count({ where: { role: 'owner' } })) <= 1) {
      return reply.code(400).send({ error: 'That is the last owner. Promote someone else first.' });
    }
    await prisma.adminUser.update({ where: { id }, data: { role } });
    await audit(admin.username, 'admin.role', id, { username: target.username, role });
    return reply.send({ ok: true });
  });

  app.delete('/api/admin/admins/:id', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'No such admin.' });
    if (target.username === admin.username) return reply.code(400).send({ error: "You can't delete yourself." });
    if ((await prisma.adminUser.count()) <= 1) return reply.code(400).send({ error: 'Cannot delete the last admin.' });
    await prisma.adminUser.delete({ where: { id } });
    await audit(admin.username, 'admin.delete', id, { username: target.username });
    return reply.send({ ok: true });
  });

  // ---- activity feed ----
  app.get('/api/admin/activity', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const [users, lakes, trips, friendships] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { displayName: true, createdAt: true } }),
      prisma.lake.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { name: true, region: true, createdAt: true } }),
      prisma.trip.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { user: { select: { displayName: true } }, lake: { select: { name: true } } } }),
      prisma.friendship.findMany({ where: { status: 'accepted' }, orderBy: { updatedAt: 'desc' }, take: 10, include: { user: { select: { displayName: true } }, friend: { select: { displayName: true } } } }),
    ]);
    const events = [
      ...users.map((u) => ({ t: u.createdAt, kind: 'signup', text: `${u.displayName} joined` })),
      ...lakes.map((l) => ({ t: l.createdAt, kind: 'lake', text: `Lake added: ${l.name}${l.region ? ` (${l.region})` : ''}` })),
      ...trips.map((x) => ({ t: x.createdAt, kind: 'catch', text: `${x.user.displayName} shared a ${x.species || 'catch'} on ${x.lake.name}` })),
      ...friendships.map((f) => ({ t: f.updatedAt, kind: 'friend', text: `${f.user.displayName} & ${f.friend.displayName} became friends` })),
    ].sort((a, b) => +new Date(b.t) - +new Date(a.t)).slice(0, 40);
    return { events };
  });

  // ---- lakes ----
  app.get('/api/admin/lakes', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const lakes = await prisma.lake.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { profile: { select: { source: true, verified: true } }, _count: { select: { userLakes: true, trips: true } } } });
    return { lakes: lakes.map((l) => ({ id: l.id, name: l.name, region: l.region, profile: l.profile?.source || null, verified: l.profile?.verified || false, savedBy: l._count.userLakes, catches: l._count.trips })) };
  });

  // ---- system health ----
  app.get('/api/admin/health', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;

    // ---- database ----
    let db = 'down';
    let dbBytes = 0;
    let dbConns = 0;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = 'ok';
      const rows = await prisma.$queryRaw<{ bytes: number; conns: number }[]>`
        SELECT pg_database_size(current_database())::float8 AS bytes,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns`;
      if (rows[0]) { dbBytes = Number(rows[0].bytes) || 0; dbConns = Number(rows[0].conns) || 0; }
    } catch { /* down */ }

    // ---- record counts (best-effort) ----
    let counts: Record<string, number> = {};
    try {
      const [users, lakes, messages, sessions, friendships] = await Promise.all([
        prisma.user.count(), prisma.lake.count(), prisma.message.count(),
        prisma.session.count(), prisma.friendship.count(),
      ]);
      counts = { users, lakes, messages, sessions, friendships };
    } catch { /* ignore */ }

    // ---- host metrics ----
    const cpus = os.cpus();
    const load = os.loadavg();
    let disk: { total: number; free: number } | null = null;
    try {
      const s = (fs as typeof fs & { statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number } }).statfsSync?.('/');
      if (s) disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch { /* ignore */ }

    // Everything else that can fail quietly. Each of these has taken the app
    // down or lost data at some point in its life, and none of them was on
    // this page until it did.
    const backup = latestBackup();
    // The failure that made this worth reporting: the container lost outbound
    // networking and every health surface still said "ok", because they all
    // check the database and the database is local.
    const net = await egressOk();
    const [photoAgg, pushCount, sourcesFailing, sourcesTotal, lastReading] = await Promise.all([
      prisma.photo.aggregate({ _count: { _all: true }, _sum: { bytes: true } }).catch(() => null),
      prisma.pushSubscription.count({ where: { failedAt: null } }).catch(() => 0),
      prisma.reportSource.count({ where: { active: true, lastError: { not: null } } }).catch(() => 0),
      prisma.reportSource.count({ where: { active: true } }).catch(() => 0),
      prisma.waterReading.findFirst({ orderBy: { at: 'desc' }, select: { at: true } }).catch(() => null),
    ]);

    return {
      status: db === 'ok' ? 'ok' : 'down',
      db, dbBytes, dbConns, counts,
      storage: {
        configured: storageConfigured(),
        objects: photoAgg?._count._all || 0,
        bytes: photoAgg?._sum.bytes || 0,
      },
      push: { configured: pushConfigured(), devices: pushCount },
      internet: net,
      backup: backup ? { name: backup.name, at: new Date(backup.at).toISOString(), bytes: backup.bytes, ageHours: Math.round((Date.now() - backup.at) / 3600_000), offsite: backup.offsite ?? null } : null,
      feeds: { active: sourcesTotal, failing: sourcesFailing },
      water: { lastReadingAt: lastReading?.at || null },
      heartbeat: { configured: !!process.env.HEARTBEAT_URL },
      // Whether sign-in email actually WORKS — `email` below is only "a key is
      // set". A broken sender locks every user out silently, so the delivery
      // record belongs on the health page.
      emailHealth: emailStatus(),
      clientErrors24h: await prisma.clientError.count({ where: { createdAt: { gt: new Date(Date.now() - 86400000) } } }).catch(() => 0),
      aiCost30d: (await prisma.aiUsage.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }, _sum: { costUsd: true } }).catch(() => null))?._sum.costUsd || 0,
      magicLinkDev: env.devShowMagicLink,
      uptimeSec: Math.round(process.uptime()),
      hostUptimeSec: Math.round(os.uptime()),
      cpu: { cores: cpus.length || 1, model: cpus[0]?.model?.trim() || 'unknown', load1: load[0], load5: load[1], load15: load[2] },
      mem: { total: os.totalmem(), free: os.freemem(), appRss: process.memoryUsage().rss },
      disk,
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: process.arch,
      ai: !!process.env.ANTHROPIC_API_KEY,
      email: !!process.env.RESEND_API_KEY,
      mode: process.env.NODE_ENV || 'development',
    };
  });

  // ---- report sources ----
  // Where fishing reports come from. Operator-managed on purpose: we fetch what
  // someone has deliberately pointed us at, not whatever we can reach.
  app.get('/api/admin/report-sources', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const [sources, counts] = await Promise.all([
      prisma.reportSource.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.lakeReport.groupBy({ by: ['source'], _count: { _all: true } }),
    ]);
    const recent = await prisma.lakeReport.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 15,
      select: { source: true, sourceName: true, title: true, publishedAt: true, lake: { select: { name: true } } },
    });
    // How many reports each source has actually produced, and when it last
    // managed one. "Active" told you a box was ticked, not that it was working.
    const perSource = await prisma.lakeReport.groupBy({
      by: ['sourceName'],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const bySourceName = new Map(perSource.map((p) => [p.sourceName || '', { n: p._count._all, last: p._max.createdAt }]));
    return {
      sources: sources.map((src) => {
        const hit = bySourceName.get(src.name);
        return {
          ...src,
          storedItems: hit?.n || 0,
          lastStoredAt: hit?.last || null,
          // Fetched recently and stored nothing is its own kind of broken: no
          // error, no output, and nothing on this page said so before.
          quiet: !!src.lastFetchedAt && !hit?.n,
        };
      }),
      counts: counts.map((c) => ({ source: c.source, n: c._count._all })),
      recent,
    };
  });

  app.post('/api/admin/report-sources', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const b = (req.body || {}) as { name?: string; url?: string; kind?: string; region?: string; lakeId?: string };
    const name = String(b.name || '').trim();
    const url = String(b.url || '').trim();
    if (!name || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'Needs a name and an http(s) URL.' });
    const src = await prisma.reportSource.create({
      data: {
        name: name.slice(0, 120),
        url,
        kind: b.kind === 'html' ? 'html' : 'rss',
        region: b.region ? String(b.region).slice(0, 60) : null,
        lakeId: b.lakeId ? String(b.lakeId) : null,
      },
    });
    await audit(admin.username, 'admin.report_source_add', src.id, { name, url });
    // Pull it straight away so the operator sees whether it works.
    const r = await fetchSource(src.id).catch((e) => ({ stored: 0, scanned: 0, error: (e as Error).message }));
    return reply.send({ source: src, first: r });
  });

  app.delete('/api/admin/report-sources/:id', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    await prisma.reportSource.deleteMany({ where: { id } });
    await audit(admin.username, 'admin.report_source_remove', id);
    return reply.send({ ok: true });
  });

  // Attach each lake's official state page, where we have a resolver for that
  // state. Safe to re-run: a lake that already has one is skipped.
  app.post('/api/admin/report-sources/official', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const r = await attachOfficialSourcesForAll().catch((e) => ({ checked: 0, added: 0, urls: [], error: (e as Error).message }));
    await audit(admin.username, 'admin.official_sources_attach', undefined, { added: r.added });
    return reply.send(r);
  });

  /** Fetch one source now, and say what it did. Refreshing all of them to test
   *  one is how a slow feed makes the whole page feel broken. */
  app.post('/api/admin/report-sources/:id/fetch', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const r = await fetchSource(id);
    return reply.send(r);
  });

  app.post('/api/admin/report-sources/refresh', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const r = await refreshAllSources().catch((e) => ({ sources: 0, stored: 0, error: (e as Error).message }));
    return reply.send(r);
  });

  // ---- AI usage + cost ----
  // What the model calls actually cost, by day and by feature. Cost is stored
  // per call at the price in force then, so these totals never drift when
  // pricing changes.
  app.get('/api/admin/ai-usage', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days || 30) || 30));
    const since = new Date(Date.now() - days * 86400000);

    const [byFeature, byModel, byDay, totals, recent] = await Promise.all([
      prisma.aiUsage.groupBy({
        by: ['feature'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true },
        _count: { _all: true },
      }),
      prisma.aiUsage.groupBy({
        by: ['model'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      prisma.$queryRaw<{ day: Date; cost: number; calls: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day,
               SUM("costUsd")::float8 AS cost,
               COUNT(*) AS calls
        FROM "AiUsage" WHERE "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
      prisma.aiUsage.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, webSearches: true },
        _count: { _all: true },
        _avg: { ms: true },
      }),
      prisma.aiUsage.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { feature: true, model: true, inputTokens: true, outputTokens: true, costUsd: true, ms: true, ok: true, createdAt: true },
      }),
    ]);

    // Was it any good? Cost without quality is half the decision.
    const votes = await prisma.planFeedback.groupBy({
      by: ['model', 'helpful'],
      _count: { _all: true },
    });
    const quality = new Map<string, { up: number; down: number }>();
    for (const v of votes) {
      const key = v.model || 'unknown';
      const q = quality.get(key) || { up: 0, down: 0 };
      if (v.helpful) q.up += v._count._all; else q.down += v._count._all;
      quality.set(key, q);
    }
    const recentNotes = await prisma.planFeedback.findMany({
      where: { note: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { helpful: true, note: true, model: true, createdAt: true },
    });

    // Flag any model we have no price for, so a 0 never reads as "free".
    const unpriced = [...new Set(byModel.map((m) => m.model))].filter((m) => !rateFor(m));
    const failures = await prisma.aiUsage.count({ where: { createdAt: { gte: since }, ok: false } });

    return {
      days,
      totals: {
        calls: totals._count._all,
        costUsd: totals._sum.costUsd || 0,
        inputTokens: totals._sum.inputTokens || 0,
        outputTokens: totals._sum.outputTokens || 0,
        cacheReadTokens: totals._sum.cacheReadTokens || 0,
        webSearches: totals._sum.webSearches || 0,
        avgMs: Math.round(totals._avg.ms || 0),
        failures,
      },
      byFeature: byFeature.map((f) => ({
        feature: f.feature, calls: f._count._all, costUsd: f._sum.costUsd || 0,
        inputTokens: f._sum.inputTokens || 0, outputTokens: f._sum.outputTokens || 0,
      })).sort((a, b) => b.costUsd - a.costUsd),
      byModel: byModel.map((m) => ({
        model: m.model, calls: m._count._all, costUsd: m._sum.costUsd || 0,
        inputTokens: m._sum.inputTokens || 0, outputTokens: m._sum.outputTokens || 0,
        priced: !!rateFor(m.model),
        up: quality.get(m.model)?.up || 0,
        down: quality.get(m.model)?.down || 0,
      })).sort((a, b) => b.costUsd - a.costUsd),
      notes: recentNotes,
      byDay: byDay.map((d) => ({ day: d.day, cost: Number(d.cost) || 0, calls: Number(d.calls) })),
      unpriced,
      recent,
    };
  });

  // Re-price stored usage from the current rate table. For correcting a wrong
  // table, not for re-pricing history after a vendor price change.
  /**
   * What this month will cost if nothing changes.
   *
   * Spend was reported for the last thirty days and nothing projected forward,
   * which is how a bill surprises somebody. The projection is deliberately
   * simple — today's daily average across the month — because a clever model
   * of a number that swings with one busy weekend would be false precision.
   */
  app.get('/api/admin/ai-forecast', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const daysIn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();

    const [monthAgg, weekAgg] = await Promise.all([
      prisma.aiUsage.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true }, _count: { _all: true } }),
      prisma.aiUsage.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } }, _sum: { costUsd: true } }),
    ]);
    const spent = monthAgg._sum.costUsd || 0;
    const perDayThisMonth = dayOfMonth ? spent / dayOfMonth : 0;
    const perDayThisWeek = (weekAgg._sum.costUsd || 0) / 7;
    // The recent rate is the better predictor when usage is growing, so take
    // whichever is higher and say which was used.
    const rate = Math.max(perDayThisMonth, perDayThisWeek);
    const budget = Number(process.env.AI_MONTHLY_BUDGET_USD || 0);
    const projected = rate * daysIn;
    return {
      spent: Math.round(spent * 100) / 100,
      calls: monthAgg._count._all,
      perDay: Math.round(rate * 100) / 100,
      basis: perDayThisWeek > perDayThisMonth ? 'the last 7 days' : 'this month so far',
      projected: Math.round(projected * 100) / 100,
      daysIn, dayOfMonth,
      budget: budget || null,
      overBudget: !!budget && projected > budget,
    };
  });

  app.post('/api/admin/ai-usage/recalculate', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const r = await recalculateCosts();
    await audit(admin.username, 'admin.ai_cost_recalculate', undefined, r);
    return reply.send(r);
  });

  // Rebuild the Corps project index (slow: every district's location list).
  app.post('/api/admin/corps-index', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const r = await buildIndex().catch((e) => ({ offices: 0, projects: 0, error: (e as Error).message }));
    await audit(admin.username, 'admin.corps_index_rebuild', undefined, r);
    return reply.send(r);
  });

  // ---- client errors ----
  // A JS exception on someone's phone is invisible server-side; this is where
  // it surfaces.
  app.get('/api/admin/client-errors', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const rows = await prisma.clientError.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    // Group identical messages so one broken line doesn't fill the page.
    const groups = new Map<string, { message: string; count: number; last: Date; url: string | null; stack: string | null }>();
    for (const r of rows) {
      const g = groups.get(r.message);
      if (g) { g.count++; if (r.createdAt > g.last) g.last = r.createdAt; }
      else groups.set(r.message, { message: r.message, count: 1, last: r.createdAt, url: r.url, stack: r.stack });
    }
    return { errors: [...groups.values()].sort((a, b) => b.last.getTime() - a.last.getTime()), total: rows.length };
  });

  // ---- sign-in links ----
  // Diagnostics only: tokens are stored hashed, so a link can never be read
  // back out of the database. This shows whether links are being requested and
  // used; use the break-glass generator below to get an actual link.
  app.get('/api/admin/magic-links', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const rows = await prisma.authToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, email: true, purpose: true, createdAt: true, expiresAt: true, usedAt: true, ip: true },
    });
    return {
      links: rows.map((r) => ({
        ...r,
        state: r.usedAt ? 'used' : r.expiresAt.getTime() < Date.now() ? 'expired' : 'pending',
      })),
      email: emailStatus(),
    };
  });

  // Break-glass: mint a one-time sign-in link for an address and show it to the
  // admin once. For when email delivery is down and someone has to get in.
  // Audited — this is, by design, a way into another user's account.
  app.post('/api/admin/signin-link', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const email = String((req.body as { email?: string }).email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Enter a valid email address.' });
    }
    const base = env.publicBaseUrl || `${req.protocol}://${req.headers.host}`;
    const link = await issueMagicLink(email, undefined, clientIp(req), base);
    await audit(admin.username, 'admin.signin_link', email, { purpose: link.purpose, emailed: link.emailed });
    return reply.send({
      url: link.url,
      purpose: link.purpose,
      expiresAt: link.expiresAt,
      emailed: link.emailed,
    });
  });

  // ---- changelog ----
  // Every update, fix and change that has shipped, newest first: the commit
  // history of the running build, classified by conventional-commit type,
  // searchable and grouped by day. Commits that exist on the branch but aren't
  // in this build yet are shown on top as "not deployed".
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;

  app.get('/api/admin/changelog', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const q = String((req.query as { q?: string }).q || '').trim();
    const offset = Math.max(0, Number((req.query as { offset?: string }).offset || 0) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number((req.query as { limit?: string }).limit || DEFAULT_LIMIT) || DEFAULT_LIMIT)
    );

    let history;
    try {
      history = await loadHistory(!!q);
    } catch (e) {
      req.log.error({ err: e }, 'changelog history unavailable');
      return reply.code(503).send({ error: 'No commit history available in this build.' });
    }

    const build = buildInfo();
    // Everything in the baked history is, by definition, what is running — so
    // it all went live when this image was built.
    const shaToDeployedAt = new Map<string, string>();
    if (build.builtAt) for (const c of history.commits) shaToDeployedAt.set(c.sha, build.builtAt);

    // Commits pushed since this image was built: real rows, marked pending.
    let pending: RawCommit[] = [];
    try {
      const target = await targetVersion();
      if (build.commit && target.commit && build.commit !== target.commit) {
        const incoming = await incomingCommits(build.commit, target.commit);
        pending = incoming.map((c) => ({
          sha: c.fullSha || c.sha,
          authoredAt: c.committedAt || new Date().toISOString(),
          committedAt: c.committedAt || new Date().toISOString(),
          subject: c.subject,
          body: c.body || '',
          files: [],
        }));
      }
    } catch {
      /* GitHub unreachable — the deployed history still renders */
    }

    const classified = classifyCommits([...pending, ...history.commits], shaToDeployedAt);
    const filtered = q ? classified.filter((c) => matchesQuery(c, q)) : classified;
    const page = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
      scanned: history.commits.length,
      scanCapped: history.commits.length >= MAX_SCAN,
      source: history.source,
      pendingCount: pending.length,
      latestDeploy: build.builtAt ? { deployedAt: build.builtAt, toSha: build.commitShort || '' } : null,
      types: COMMIT_TYPE_META,
      groups: groupCommitsByDay(page),
    };
  });

  // ---- audit log ----
  /**
   * Whether the plans are any good.
   *
   * Every plan carries 👍/👎 and the model that wrote it, and nothing has ever
   * read them. This is the only measurement of the app's core promise, and it
   * is what should decide which model we pay for — a cheaper model with the
   * same thumbs-up rate is simply better.
   */
  app.get('/api/admin/plan-feedback', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const since = new Date(Date.now() - 90 * 86400_000);
    const [rows, plans] = await Promise.all([
      prisma.planFeedback.findMany({
        where: { createdAt: { gte: since } },
        include: {
          user: { select: { displayName: true } },
          plan: { select: { model: true, species: true, goal: true, lakeId: true, lake: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      prisma.dayPlan.count({ where: { generatedAt: { gte: since } } }),
    ]);

    const tally = new Map<string, { model: string; up: number; down: number }>();
    const byLake = new Map<string, { lake: string; up: number; down: number }>();
    for (const r of rows) {
      const model = r.model || r.plan?.model || 'unknown';
      const t = tally.get(model) || { model, up: 0, down: 0 };
      r.helpful ? (t.up += 1) : (t.down += 1);
      tally.set(model, t);
      const lake = r.plan?.lake?.name || 'unknown';
      const l = byLake.get(lake) || { lake, up: 0, down: 0 };
      r.helpful ? (l.up += 1) : (l.down += 1);
      byLake.set(lake, l);
    }
    const rate = (t: { up: number; down: number }) => (t.up + t.down ? Math.round((t.up / (t.up + t.down)) * 100) : null);

    // What each model costs per plan, so quality can be weighed against price
    // in the same breath rather than on two different screens.
    const spend = await prisma.aiUsage.groupBy({
      by: ['model'],
      where: { createdAt: { gte: since }, feature: 'day_plan' },
      _sum: { costUsd: true },
      _count: { _all: true },
    });
    const perPlan = new Map(
      spend.map((m) => [m.model, m._count._all ? (m._sum.costUsd || 0) / m._count._all : 0])
    );

    return {
      plans,
      rated: rows.length,
      // How much of the work is actually being judged. A rate computed from
      // six votes out of four hundred plans is not a measurement.
      coverage: plans ? Math.round((rows.length / plans) * 100) : 0,
      models: [...tally.values()]
        .map((t) => ({ ...t, helpfulPct: rate(t), costPerPlan: Math.round((perPlan.get(t.model) || 0) * 10000) / 10000 }))
        .sort((a, b) => b.up + b.down - (a.up + a.down)),
      lakes: [...byLake.values()].map((l) => ({ ...l, helpfulPct: rate(l) })).sort((a, b) => (rate(a) ?? 100) - (rate(b) ?? 100)).slice(0, 10),
      notes: rows
        .filter((r) => r.note)
        .slice(0, 40)
        .map((r) => ({
          helpful: r.helpful,
          note: r.note,
          model: r.model || r.plan?.model || null,
          lake: r.plan?.lake?.name || null,
          species: r.plan?.species || null,
          at: r.createdAt,
        })),
    };
  });

  // ---------- 1: the social half of the app, which had no tab at all ----------
  /** Groups, tournaments, seasons, classifieds and invites, in one place. */
  app.get('/api/admin/community', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const kind = String((req.query as { kind?: string }).kind || 'groups');
    const take = 100;

    if (kind === 'tournaments') {
      const rows = await prisma.tournament.findMany({
        orderBy: { startsAt: 'desc' }, take,
        include: {
          host: { select: { displayName: true } },
          group: { select: { name: true } },
          series: { select: { name: true, year: true } },
          lake: { select: { name: true } },
          _count: { select: { entries: true, catches: true } },
        },
      });
      return { kind, rows: rows.map((t) => ({
        id: t.id, name: t.name, status: t.status, startsAt: t.startsAt, host: t.host.displayName,
        group: t.group.name, series: t.series ? `${t.series.name} ${t.series.year}` : null,
        lake: t.lake?.name || null, entries: t._count.entries, catches: t._count.catches,
      })) };
    }
    if (kind === 'listings') {
      const rows = await prisma.listing.findMany({
        orderBy: { bumpedAt: 'desc' }, take,
        include: { seller: { select: { displayName: true, status: true } }, _count: { select: { photos: true } } },
      });
      return { kind, rows: rows.map((l) => ({
        id: l.id, title: l.title, priceCents: l.priceCents, category: l.category, status: l.status,
        seller: l.seller.displayName, sellerActive: l.seller.status === 'active',
        photos: l._count.photos, createdAt: l.createdAt,
      })) };
    }
    if (kind === 'invites') {
      const rows = await prisma.invite.findMany({
        orderBy: { createdAt: 'desc' }, take,
        include: { inviter: { select: { displayName: true } }, acceptedBy: { select: { displayName: true } } },
      });
      return { kind, rows: rows.map((i) => ({
        id: i.id, email: i.email, inviter: i.inviter.displayName, sent: !!i.sentAt,
        accepted: !!i.acceptedAt, acceptedBy: i.acceptedBy?.displayName || null,
        revoked: !!i.revokedAt, createdAt: i.createdAt,
      })) };
    }
    // Groups, which is where most of the social activity actually lives.
    const rows = await prisma.friendGroup.findMany({
      orderBy: { createdAt: 'desc' }, take,
      include: {
        owner: { select: { displayName: true } },
        _count: { select: { members: true, posts: true, tournaments: true, messages: true } },
      },
    });
    return { kind: 'groups', rows: rows.map((g) => ({
      id: g.id, name: g.name, owner: g.owner.displayName, dataSharing: g.dataSharing,
      members: g._count.members, posts: g._count.posts, tournaments: g._count.tournaments,
      messages: g._count.messages, createdAt: g.createdAt,
    })) };
  });

  // ---------- 2: what is actually in the bucket ----------
  /**
   * The database knows which objects it MEANT to create; the bucket knows what
   * is really there. The gap is what a cascade left behind, and it is the one
   * thing here that quietly costs money every month.
   */
  app.get('/api/admin/storage', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!storageConfigured()) return { configured: false };
    const token = String((req.query as { token?: string }).token || '') || undefined;
    const listed = await listObjects('', 1000, token);
    if (!listed) return { configured: true, error: 'The bucket would not answer.' };
    const keys = listed.objects.map((o) => o.key);
    const known = keys.length
      ? await prisma.photo.findMany({ where: { key: { in: keys } }, select: { key: true } })
      : [];
    const knownSet = new Set(known.map((k) => k.key));
    const objects = listed.objects.map((o) => ({ ...o, orphan: !knownSet.has(o.key) && !/^backups\//.test(o.key) }));
    return {
      configured: true,
      objects,
      next: listed.next,
      totals: {
        shown: objects.length,
        bytes: objects.reduce((a, o) => a + o.size, 0),
        orphans: objects.filter((o) => o.orphan).length,
        orphanBytes: objects.filter((o) => o.orphan).reduce((a, o) => a + o.size, 0),
      },
    };
  });

  /** Delete objects nothing points at any more. Owner only: it is permanent. */
  app.post('/api/admin/storage/sweep', async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const keys = (req.body as { keys?: string[] })?.keys;
    if (!Array.isArray(keys) || !keys.length) return reply.code(400).send({ error: 'Nothing to sweep.' });
    // Never delete something the database still points at, whatever was asked.
    const stillUsed = await prisma.photo.findMany({ where: { key: { in: keys.map(String) } }, select: { key: true } });
    const used = new Set(stillUsed.map((k) => k.key));
    let removed = 0;
    let failed = 0;
    let kept = 0;
    for (const key of keys.map(String).slice(0, 500)) {
      if (used.has(key) || /^backups\//.test(key)) { kept += 1; continue; }
      if (await deleteObject(key).catch(() => false)) removed += 1;
      else failed += 1;
    }
    await audit(admin.username, 'storage.sweep', String(removed), { requested: keys.length, failed });
    return reply.send({ ok: true, removed, kept, failed });
  });

  /** One lake and everything we know about it. The lakes tab was a list. */
  app.get('/api/admin/lakes/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = String((req.params as { id: string }).id);
    const lake = await prisma.lake.findUnique({
      where: { id },
      include: { profile: { select: { source: true, verified: true, generatedAt: true, model: true } } },
    });
    if (!lake) return reply.code(404).send({ error: 'No such lake.' });

    const [anglers, trips, spots, waypoints, reports, plans, readings, recentReports, topAnglers] = await Promise.all([
      prisma.userLake.count({ where: { lakeId: id } }),
      prisma.trip.count({ where: { lakeId: id } }),
      prisma.spot.count({ where: { lakeId: id } }),
      prisma.waypoint.count({ where: { lakeId: id } }),
      prisma.lakeReport.count({ where: { lakeId: id } }),
      prisma.dayPlan.count({ where: { lakeId: id } }),
      prisma.waterReading.count({ where: { lakeId: id } }),
      prisma.lakeReport.findMany({ where: { lakeId: id }, orderBy: { createdAt: 'desc' }, take: 8, select: { source: true, sourceName: true, publishedAt: true, body: true } }),
      prisma.trip.groupBy({ by: ['userId'], where: { lakeId: id }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 5 }),
    ]);
    const names = topAnglers.length
      ? await prisma.user.findMany({ where: { id: { in: topAnglers.map((t) => t.userId) } }, select: { id: true, displayName: true } })
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.displayName]));

    let regs: unknown = null;
    try { regs = lake.regsJson ? JSON.parse(lake.regsJson) : null; } catch { regs = null; }
    let features: { kind: string }[] = [];
    try { features = lake.featuresJson ? (JSON.parse(lake.featuresJson) as { kind: string }[]) : []; } catch { features = []; }
    let ramps = 0;
    try { ramps = lake.rampsJson ? (JSON.parse(lake.rampsJson) as unknown[]).length : 0; } catch { ramps = 0; }
    const featureKinds: Record<string, number> = {};
    for (const f of features) featureKinds[f.kind] = (featureKinds[f.kind] || 0) + 1;

    return {
      lake: {
        id: lake.id, name: lake.name, region: lake.region, country: lake.country,
        lat: lake.lat, lon: lake.lon, gaugeId: lake.gaugeId, fullPool: lake.fullPool,
        corpsProject: lake.corpsProject, addedAt: lake.createdAt,
        profile: lake.profile,
      },
      counts: { anglers, trips, spots, waypoints, reports, plans, readings, features: features.length, ramps },
      featureKinds,
      regulations: regs,
      recentReports: recentReports.map((r) => ({ source: r.source, sourceName: r.sourceName, publishedAt: r.publishedAt, body: r.body.slice(0, 160) })),
      topAnglers: topAnglers.map((t) => ({ name: nameOf.get(t.userId) || 'unknown', trips: t._count._all })),
    };
  });

  // ---------- 10: sessions, so "someone else is in my account" has an answer ----------
  app.get('/api/admin/users/:id/sessions', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = String((req.params as { id: string }).id);
    const rows = await prisma.session.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, createdAt: true, expiresAt: true, ip: true, userAgent: true },
    });
    return {
      sessions: rows.map((r) => ({
        id: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt,
        ip: r.ip, device: shortDevice(r.userAgent || ''),
        expired: r.expiresAt.getTime() < Date.now(),
      })),
    };
  });

  /** Sign a device out. One, or all of them. */
  app.delete('/api/admin/users/:id/sessions', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const one = String((req.query as { session?: string }).session || '');
    const r = await prisma.session.deleteMany({ where: { userId: id, ...(one ? { id: one } : {}) } });
    await audit(admin.username, one ? 'session.revoke' : 'session.revokeAll', id, { removed: r.count });
    return reply.send({ ok: true, removed: r.count });
  });

  // ---------- moderation queue ----------
  app.get('/api/admin/flags', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const status = String((req.query as { status?: string }).status || 'open');
    const rows = await prisma.contentFlag.findMany({
      where: status === 'all' ? {} : { status },
      include: {
        reporter: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // How many other people flagged the same thing — one report is a
    // complaint, five is a pattern, and the queue should show which is which.
    const counts = await prisma.contentFlag.groupBy({
      by: ['targetType', 'targetId'],
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [`${c.targetType}:${c.targetId}`, c._count._all]));
    return {
      flags: rows.map((f) => ({
        id: f.id,
        targetType: f.targetType,
        targetId: f.targetId,
        reason: f.reason,
        note: f.note,
        snapshot: f.snapshot,
        status: f.status,
        resolution: f.resolution,
        reporter: f.reporter,
        reviewedBy: f.reviewedBy,
        reportCount: countOf.get(`${f.targetType}:${f.targetId}`) || 1,
        createdAt: f.createdAt,
      })),
      openCount: await prisma.contentFlag.count({ where: { status: 'open' } }),
    };
  });

  /**
   * The thing that was reported, with what is around it.
   *
   * The queue shows a snapshot taken when the report was raised, so a comment
   * arrives with no thread and a post with no replies — you are judging a
   * sentence without the conversation it sat in.
   */
  app.get('/api/admin/flags/:id/context', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = String((req.params as { id: string }).id);
    const flag = await prisma.contentFlag.findUnique({ where: { id } });
    if (!flag) return reply.code(404).send({ error: 'No such report.' });

    const author = { displayName: '', id: '', status: '' };
    let thread: { who: string; body: string; at: Date; isTarget: boolean }[] = [];
    let gone = false;

    if (flag.targetType === 'post' || flag.targetType === 'comment') {
      const postId = flag.targetType === 'post'
        ? flag.targetId
        : (await prisma.postComment.findUnique({ where: { id: flag.targetId }, select: { postId: true } }))?.postId;
      const post = postId
        ? await prisma.post.findUnique({
            where: { id: postId },
            include: {
              author: { select: { id: true, displayName: true, status: true } },
              comments: { orderBy: { createdAt: 'asc' }, take: 30, include: { author: { select: { displayName: true } } } },
            },
          })
        : null;
      if (!post) gone = true;
      else {
        Object.assign(author, post.author);
        thread = [
          { who: post.author.displayName, body: post.body, at: post.createdAt, isTarget: flag.targetType === 'post' },
          ...post.comments.map((c) => ({ who: c.author.displayName, body: c.body, at: c.createdAt, isTarget: c.id === flag.targetId })),
        ];
      }
    } else if (flag.targetType === 'listing') {
      const l = await prisma.listing.findUnique({ where: { id: flag.targetId }, include: { seller: { select: { id: true, displayName: true, status: true } } } });
      if (!l) gone = true;
      else {
        Object.assign(author, l.seller);
        thread = [{ who: l.seller.displayName, body: `${l.title}\n${l.body}`, at: l.createdAt, isTarget: true }];
      }
    } else if (flag.targetType === 'user') {
      const u = await prisma.user.findUnique({ where: { id: flag.targetId }, select: { id: true, displayName: true, status: true, bio: true, createdAt: true } });
      if (!u) gone = true;
      else {
        Object.assign(author, u);
        thread = [{ who: u.displayName, body: u.bio || '(no bio)', at: u.createdAt, isTarget: true }];
      }
    }

    // Has this angler been reported before? One complaint is a complaint;
    // the fourth is a pattern, and the decision is different.
    const history = author.id
      ? await prisma.contentFlag.count({ where: { targetId: author.id, targetType: 'user' } }) +
        // A blank display name would make `contains: ''` match every snapshot
        // on the platform, so the name has to be worth searching for.
        (author.displayName.trim().length >= 3
          ? await prisma.contentFlag.count({ where: { targetType: { in: ['post', 'comment', 'listing'] }, targetId: { not: flag.targetId }, snapshot: { contains: author.displayName } } })
          : 0)
      : 0;

    return { flag, author, thread, gone, priorReports: history, snapshot: flag.snapshot };
  });

  /**
   * Resolve a flag, optionally deleting what it points at. Deleting here is the
   * whole reason the queue exists — a queue you can only mark as read is a
   * to-do list, not moderation.
   */
  app.post('/api/admin/flags/:id', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { action?: string; resolution?: string };
    const flag = await prisma.contentFlag.findUnique({ where: { id } });
    if (!flag) return reply.code(404).send({ error: 'No such report.' });

    let removed = false;
    if (b.action === 'remove') {
      try {
        if (flag.targetType === 'post') { await prisma.post.delete({ where: { id: flag.targetId } }); removed = true; }
        else if (flag.targetType === 'comment') { await prisma.postComment.delete({ where: { id: flag.targetId } }); removed = true; }
        else if (flag.targetType === 'listing') { await prisma.listing.delete({ where: { id: flag.targetId } }); removed = true; }
        else if (flag.targetType === 'user') { await prisma.user.update({ where: { id: flag.targetId }, data: { status: 'suspended' } }); removed = true; }
      } catch {
        // Already gone — that is still a resolved report, not an error.
      }
    }
    await audit(admin.username, `moderation.${b.action === 'dismiss' ? 'dismiss' : 'remove'}`, `${flag.targetType}:${flag.targetId}`, { removed });
    await prisma.contentFlag.update({
      where: { id },
      data: {
        status: b.action === 'dismiss' ? 'dismissed' : 'actioned',
        resolution: String(b.resolution || '').slice(0, 500) || (removed ? 'Content removed.' : null),
        reviewedBy: admin.username,
        reviewedAt: new Date(),
      },
    });
    // Every other open report about the same thing is resolved with it.
    await prisma.contentFlag.updateMany({
      where: { targetType: flag.targetType, targetId: flag.targetId, status: 'open', id: { not: id } },
      data: { status: b.action === 'dismiss' ? 'dismissed' : 'actioned', reviewedBy: admin.username, reviewedAt: new Date() },
    });
    return reply.send({ ok: true, removed });
  });

  app.get('/api/admin/audit', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const q = req.query as { action?: string; target?: string; by?: string; page?: string };
    const page = Math.max(Number(q.page) || 1, 1);
    const size = 100;
    // "Everything this admin did" and "everything done to this angler" are the
    // two questions an audit log exists to answer, and neither could be asked.
    const where = {
      ...(q.action ? { action: { contains: String(q.action), mode: 'insensitive' as const } } : {}),
      ...(q.target ? { target: String(q.target) } : {}),
      ...(q.by ? { meta: { path: ['by'], equals: String(q.by) } } : {}),
    };
    const [total, log, actions] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 25 }),
    ]);
    return {
      log, total, page, pages: Math.max(1, Math.ceil(total / size)),
      actions: actions.map((a) => ({ action: a.action, n: a._count._all })),
    };
  });
}

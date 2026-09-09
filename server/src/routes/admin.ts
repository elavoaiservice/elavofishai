import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { clientIp } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import {
  startAdminLogin, completeAdminLogin, endAdminSession, currentAdmin, requireAdmin, createAdminUser,
} from '../lib/admin-auth';

// Lightweight audit trail for admin actions (actor kept in meta.by; AuditLog.userId
// is for end-users, so we leave it null for admin-initiated events).
async function audit(by: string, action: string, target?: string, meta?: Record<string, unknown>) {
  try {
    await prisma.auditLog.create({ data: { action, target: target || null, meta: { by, ...(meta || {}) } } });
  } catch { /* never block on audit */ }
}
import { CATALOG, maskedView, setValue, testValue, loadOverlay } from '../config-store';
import { versionStatus } from '../version';

const DEPLOY_DIR = '/deploy';
const TRIGGER = path.join(DEPLOY_DIR, 'trigger');
const LOCK = path.join(DEPLOY_DIR, 'upgrade.lock');
const LOG = path.join(DEPLOY_DIR, 'status.log');

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- auth ----
  app.post('/api/admin/login', async (req, reply) => {
    const b = (req.body || {}) as { username?: string; password?: string };
    if (await overLimit(`adminlogin:${clientIp(req)}`, 10, 10 * 60000)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a few minutes.' });
    }
    const r = await startAdminLogin(String(b.username || ''), String(b.password || ''));
    if (!r.ok) return reply.code(401).send({ error: r.error });
    // devCode present only in dev/console mode (until email is configured).
    return reply.send({ ok: true, mfa: true, devCode: r.code });
  });

  app.post('/api/admin/mfa', async (req, reply) => {
    const b = (req.body || {}) as { username?: string; code?: string };
    const ok = await completeAdminLogin(String(b.username || ''), String(b.code || ''), reply);
    if (!ok) return reply.code(401).send({ error: 'Invalid or expired code.' });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/logout', async (req, reply) => {
    await endAdminSession(req, reply);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/me', async (req) => {
    const admin = await currentAdmin(req);
    return { admin: admin ? { username: admin.username, email: admin.email } : null };
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
    const q = String((req.query as { q?: string }).q || '').trim();
    const where = q ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { displayName: { contains: q, mode: 'insensitive' as const } }] } : {};
    const users = await prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, email: true, displayName: true, role: true, status: true, createdAt: true, lastLoginAt: true, _count: { select: { userLakes: true } } },
    });
    return { users: users.map((u) => ({ ...u, lakes: u._count.userLakes, _count: undefined })) };
  });

  app.post('/api/admin/users/:id/status', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = String((req.params as { id: string }).id);
    const status = String((req.body as { status?: string }).status || '');
    if (!['active', 'suspended'].includes(status)) return reply.code(400).send({ error: 'Bad status.' });
    await prisma.user.update({ where: { id }, data: { status } });
    if (status === 'suspended') await prisma.session.deleteMany({ where: { userId: id } });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = String((req.params as { id: string }).id);
    const role = String((req.body as { role?: string }).role || '');
    if (!['user', 'pro', 'guide', 'admin'].includes(role)) return reply.code(400).send({ error: 'Bad role.' });
    await prisma.user.update({ where: { id }, data: { role: role as 'user' | 'pro' | 'guide' | 'admin' } });
    return reply.send({ ok: true });
  });

  // ---- settings (config GUI) ----
  app.get('/api/admin/config', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: await maskedView(), groups: [...new Set(CATALOG.map((c) => c.group))] };
  });

  app.put('/api/admin/config', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = (req.body || {}) as { key?: string; value?: string };
    if (!b.key) return reply.code(400).send({ error: 'Missing key.' });
    if (b.value === '••••••••') return reply.send({ ok: true, unchanged: true }); // masked, not edited
    try {
      await setValue(b.key, String(b.value ?? ''));
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
    if (!(await requireAdmin(req, reply))) return;
    if (!fs.existsSync(DEPLOY_DIR)) return reply.send({ ok: false, error: 'Upgrade agent not configured (the /deploy volume is not mounted).' });
    if (fs.existsSync(LOCK)) return reply.send({ ok: false, error: 'An upgrade is already running.' });
    try {
      fs.writeFileSync(TRIGGER, new Date().toISOString());
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
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const id = String((req.params as { id: string }).id);
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: 'No such user.' });
    await prisma.user.delete({ where: { id } }); // cascades sessions/lakes/trips/spots/kv/friendships
    await audit(admin.username, 'user.delete', id, { email: u.email });
    return reply.send({ ok: true });
  });

  // ---- admin users ----
  app.get('/api/admin/admins', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const admins = await prisma.adminUser.findMany({ select: { id: true, username: true, email: true, createdAt: true, lastLoginAt: true }, orderBy: { createdAt: 'asc' } });
    return { admins, me: admin.username };
  });

  app.post('/api/admin/admins', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
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

  app.delete('/api/admin/admins/:id', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
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

    return {
      status: db === 'ok' ? 'ok' : 'down',
      db, dbBytes, dbConns, counts,
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

  // ---- audit log ----
  app.get('/api/admin/audit', async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const log = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 80 });
    return { log };
  });
}

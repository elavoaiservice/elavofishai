import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { clientIp } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import {
  startAdminLogin, completeAdminLogin, endAdminSession, currentAdmin, requireAdmin,
} from '../lib/admin-auth';
import { CATALOG, maskedView, setValue, testValue, loadOverlay } from '../config-store';

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
    return { configured, running: fs.existsSync(LOCK), log };
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
}

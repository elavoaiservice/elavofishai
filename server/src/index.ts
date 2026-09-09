import path from 'path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { env, requireEnv } from './env';
import { prisma } from './db';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { authRoutes } from './routes/auth';
import { kvRoutes } from './routes/kv';
import { lakeRoutes } from './routes/lakes';
import { aiRoutes } from './routes/ai';
import { adminRoutes } from './routes/admin';
import { socialRoutes } from './routes/social';
import { messageRoutes } from './routes/messages';
import { loadOverlay } from './config-store';
import { bootstrapAdmin } from './lib/admin-auth';
import { currentUser } from './lib/auth';
import { sweepRateLimits } from './lib/rateLimit';
import { sweepAuthTokens } from './services/magicLink';
import { seedGranbury } from './services/seed';

const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', '..', 'public');

async function main(): Promise<void> {
  requireEnv();

  const app = Fastify({
    logger: { level: env.isProd ? 'info' : 'info' },
    trustProxy: true,
    bodyLimit: env.maxKeyBytes + 1024, // KV PUTs carry the largest bodies
  });

  await app.register(cookie);

  // KV PUT bodies are raw strings (not JSON). The built-in application/json and
  // text/plain parsers still apply for their content-types; this catch-all keeps
  // any other/empty content-type as a raw string.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  // Every /api/* response is uncacheable.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // API routes
  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(authRoutes);
  await app.register(kvRoutes);
  await app.register(lakeRoutes);
  await app.register(aiRoutes);
  await app.register(adminRoutes);
  await app.register(socialRoutes);
  await app.register(messageRoutes);

  // The planner app lives at /app — GATED: the Granbury (and all lake) data is
  // account-only. Anonymous visitors are sent to the login screen; the HTML is
  // never served to a request without a valid session.
  app.get('/app', async (req, reply) => {
    if (!(await currentUser(req))) return reply.redirect('/login');
    return reply.sendFile('index.html');
  });
  app.get('/app/', async (req, reply) => {
    if (!(await currentUser(req))) return reply.redirect('/login');
    return reply.sendFile('index.html');
  });
  // Login screen — bounce already-signed-in users straight into the app.
  app.get('/login', async (req, reply) => {
    const u = await currentUser(req);
    if (u) return reply.redirect('/app');
    return reply.sendFile('login.html');
  });
  // Admin Command Center.
  app.get('/admin', (_req, reply) => reply.sendFile('admin.html'));
  app.get('/admin/', (_req, reply) => reply.sendFile('admin.html'));

  // Static assets (icons, manifest, sw, landing) — landing.html is the index at /.
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['landing.html'],
    cacheControl: true,
    maxAge: '1h',
  });

  // Unknown non-API GETs fall back to the marketing landing (never expose data dirs).
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('landing.html');
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  // Seed the flagship lake (idempotent). Best-effort — never blocks startup.
  await seedGranbury().catch((e) => app.log.warn({ err: e }, 'granbury seed skipped'));
  // Overlay admin-managed config onto process.env, then seed the admin from env.
  await loadOverlay().catch((e) => app.log.warn({ err: e }, 'config overlay skipped'));
  await bootstrapAdmin().catch((e) => app.log.warn({ err: e }, 'admin bootstrap skipped'));

  // Periodic bounded-table sweeps.
  const hour = 3600000;
  const sweep = async () => {
    await sweepAuthTokens().catch(() => {});
    await sweepRateLimits(24 * hour).catch(() => {});
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  };
  await sweep();
  const timer = setInterval(sweep, 6 * hour);
  timer.unref();

  await app.listen({ port: env.port, host: env.host });
  app.log.info(`ElavoFishAI on http://${env.host}:${env.port} (mode=${env.nodeEnv}, magicLinkDev=${env.devShowMagicLink})`);

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', e);
  process.exit(1);
});

import path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { env, requireEnv } from './env';
import { prisma } from './db';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { authRoutes, baseUrlFor } from './routes/auth';
import { kvRoutes } from './routes/kv';
import { lakeRoutes } from './routes/lakes';
import { aiRoutes } from './routes/ai';
import { adminRoutes } from './routes/admin';
import { socialRoutes } from './routes/social';
import { messageRoutes } from './routes/messages';
import { clientErrorRoutes, sweepClientErrors } from './routes/clientErrors';
import { photoRoutes, sweepOrphanPhotos } from './routes/photos';
import { postRoutes } from './routes/posts';
import { groupPageRoutes } from './routes/groups';
import { marketRoutes } from './routes/market';
import { notificationRoutes } from './routes/notifications';
import { flagRoutes } from './routes/flags';
import { pushRoutes } from './routes/push';
import { inviteRoutes } from './routes/invites';
import { tournamentRoutes } from './routes/tournaments';
import { refreshAllSources, sweepReports } from './services/reports';
import { loadOverlay } from './config-store';
import { bootstrapAdmin } from './lib/admin-auth';
import { currentUser } from './lib/auth';
import { sweepRateLimits } from './lib/rateLimit';
import { sweepNotifications } from './services/notify';
import { sweepAuthTokens } from './services/magicLink';
import { seedGranbury } from './services/seed';

const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', '..', 'public');

// Build the app — every route and plugin, no side effects. main() adds the
// startup work (seeding, sweeps, listening); tests call this and use
// app.inject() so they never bind a port.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.isProd ? 'info' : 'info' },
    // Do NOT trust X-Forwarded-For blindly: with trustProxy on, req.ip is
    // whatever the caller put in a header. clientIp() decides what to believe
    // based on where the connection actually came from.
    trustProxy: false,
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
  await app.register(clientErrorRoutes);
  await app.register(photoRoutes);
  await app.register(postRoutes);
  await app.register(groupPageRoutes);
  await app.register(marketRoutes);
  await app.register(notificationRoutes);
  await app.register(flagRoutes);
  await app.register(pushRoutes);
  await app.register(tournamentRoutes);
  await app.register(inviteRoutes, { baseUrlFor: (req: unknown) => baseUrlFor(req as { headers: Record<string, unknown>; protocol: string }) });

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
  // Login + signup screens — bounce already-signed-in users straight into the app.
  app.get('/login', async (req, reply) => {
    if (await currentUser(req)) return reply.redirect('/app');
    return reply.sendFile('login.html');
  });
  app.get('/signup', async (req, reply) => {
    if (await currentUser(req)) return reply.redirect('/app');
    return reply.sendFile('signup.html');
  });
  // Admin Command Center.
  app.get('/admin', (_req, reply) => reply.sendFile('admin.html'));
  app.get('/admin/', (_req, reply) => reply.sendFile('admin.html'));

  // Static assets (icons, manifest, sw, landing) — landing.html is the index at /.
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['landing.html'],
    // cacheControl:false because @fastify/static applies its own header AFTER
    // setHeaders runs, so anything set here would be silently overwritten —
    // which is exactly what happened the first time: the origin kept answering
    // max-age=3600 while the code said no-cache.
    cacheControl: false,
    setHeaders(res, path) {
      // An hour of browser cache on the HTML means a fix can take an hour to
      // reach someone who already has the page — including a fix for something
      // that is actively wrong. Pages revalidate every time (a 304 is cheap and
      // the payload is gzipped anyway); the icons and the manifest, which
      // change about once a year, keep the long cache.
      // The service worker must never be cached either: a stale one keeps
      // serving a stale app and cannot replace itself.
      if (/\.html$/.test(path) || /sw\.js$/.test(path)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (/\.(png|ico|webmanifest|css|woff2?)$/.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  });

  // Unknown non-API GETs fall back to the marketing landing (never expose data dirs).
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('landing.html');
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  return app;
}

async function main(): Promise<void> {
  requireEnv();
  const app = await buildApp();

  // Seed the flagship lake (idempotent). Best-effort — never blocks startup.
  await seedGranbury().catch((e) => app.log.warn({ err: e }, 'granbury seed skipped'));
  // Overlay admin-managed config onto process.env, then seed the admin from env.
  await loadOverlay().catch((e) => app.log.warn({ err: e }, 'config overlay skipped'));
  await bootstrapAdmin().catch((e) => app.log.warn({ err: e }, 'admin bootstrap skipped'));

  /**
   * Tell an outside service we are still alive.
   *
   * Everything else that watches this app runs ON this app's machine, so none
   * of it can tell anyone when the machine itself is gone — which is the
   * outage that lasts longest, because nobody finds out until they try to use
   * the site. A dead-man's-switch service (healthchecks.io and friends) works
   * the other way round: it alerts when the pings STOP. No ping URL configured
   * means this does nothing at all, quietly.
   */
  const heartbeat = async () => {
    const url = process.env.HEARTBEAT_URL || '';
    if (!url) return;
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch {
      /* the whole point is that a missed ping is the signal — never log noise */
    }
  };
  await heartbeat();
  const beat = setInterval(heartbeat, 5 * 60_000);
  beat.unref?.();

  // Periodic bounded-table sweeps.
  const hour = 3600000;
  const sweep = async () => {
    await sweepAuthTokens().catch(() => {});
    await sweepRateLimits(24 * hour).catch(() => {});
    await sweepClientErrors().catch(() => {});
    await sweepReports().catch(() => {});
    await sweepOrphanPhotos().catch(() => {});
    await sweepNotifications().catch(() => {});
    // Pull fishing reports on the same cadence as the sweeps (every 6h).
    await refreshAllSources()
      .then((r) => r.stored && app.log.info(r, 'fishing reports refreshed'))
      .catch(() => {});
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
    await prisma.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
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

// Only start a server when run as the entry point — importing this module
// (tests do, for buildApp) must not listen on a port.
if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', e);
    process.exit(1);
  });
}

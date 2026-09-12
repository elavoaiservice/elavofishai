import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { clientIp, requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { searchLakes } from '../services/lakeSearch';
import { generateLakeProfile } from '../services/aiProfile';
import { enrichLake } from '../services/enrichLake';
import { axisLabel, resolveLakeAxis } from '../services/lakeGeometry';
import { rampsForLake } from '../services/ramps';
import { releaseFor, summarizeRelease } from '../services/corps';
import { waterFor } from '../services/water';
import { alertsFor, discussionFor } from '../services/nws';

const GRANBURY_OSM_REF = 'seed:lake-granbury';

// Public shape sent to the client. `key` is the per-lake storage namespace: the
// seeded Granbury keeps the legacy 'granbury' key (so existing local data migrates
// cleanly); every other lake namespaces by its id.
function lakeView(
  l: {
    id: string; name: string; region: string | null; country: string | null;
    lat: number; lon: number; gaugeId: string | null; gaugeSource: string; fullPool: number | null;
    osmRef: string | null; bbox?: string | null;
  },
  profileContent?: unknown
) {
  // Which way the lake runs — drives the wind/fetch advice. Null when we don't
  // actually know, so the app can stay quiet instead of guessing.
  const axisDeg = resolveLakeAxis(l.bbox, profileContent);
  return {
    id: l.id, key: l.osmRef === GRANBURY_OSM_REF ? 'granbury' : l.id,
    name: l.name, region: l.region, country: l.country,
    lat: l.lat, lon: l.lon, gaugeId: l.gaugeId, gaugeSource: l.gaugeSource, fullPool: l.fullPool,
    axisDeg, axisLabel: axisLabel(axisDeg),
  };
}

export async function lakeRoutes(app: FastifyInstance): Promise<void> {
  // Search public waters (OpenStreetMap).
  app.get('/api/lakes/search', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const q = String((req.query as { q?: string }).q || '').trim();
    if (q.length < 2) return reply.send({ results: [] });
    if (await overLimit(`lakesearch:${clientIp(req)}`, 30, 60000)) {
      return reply.code(429).send({ error: 'Slow down a moment, then search again.' });
    }
    const results = await searchLakes(q);
    return reply.send({ results });
  });

  // Add a lake (from a search result) and save it to the user's lakes. Deduped
  // globally by osmRef so everyone shares one row per real body of water.
  app.post('/api/lakes', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const b = (req.body || {}) as {
      osmRef?: string; name?: string; region?: string; country?: string;
      lat?: number; lon?: number; bbox?: string; gaugeId?: string;
    };
    const name = String(b.name || '').trim();
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return reply.code(400).send({ error: 'A lake needs a name and coordinates.' });
    }

    let lake = b.osmRef ? await prisma.lake.findUnique({ where: { osmRef: b.osmRef } }) : null;
    if (!lake) {
      lake = await prisma.lake.create({
        data: {
          name,
          region: b.region || null,
          country: b.country || null,
          lat, lon,
          bbox: b.bbox || null,
          gaugeId: b.gaugeId || null,
          gaugeSource: b.gaugeId ? 'usgs' : 'none',
          osmRef: b.osmRef || null,
          addedById: user.id,
        },
      });
      // Pull down everything public sources know about this water — gauge,
      // boat ramps, and the AI guide — in the background. Adding a lake stays
      // instant; the detail fills in behind it.
      const newId = lake.id;
      enrichLake(newId)
        .then((r) => app.log.info({ lakeId: newId, ...r }, 'lake enriched'))
        .catch((e) => app.log.warn({ err: e, lakeId: newId }, 'lake enrichment failed'));
    }

    await prisma.userLake.upsert({
      where: { userId_lakeId: { userId: user.id, lakeId: lake.id } },
      create: { userId: user.id, lakeId: lake.id },
      update: {},
    });
    return reply.send({ lake: lakeView(lake) });
  });

  // The user's saved lakes (+ which is home). Ensures Granbury is present the
  // first time so a new account always has a working home lake.
  app.get('/api/me/lakes', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await ensureHomeLake(user.id);
    const rows = await prisma.userLake.findMany({
      where: { userId: user.id },
      include: { lake: { include: { profile: { select: { content: true } } } } },
      orderBy: [{ isHome: 'desc' }, { addedAt: 'asc' }],
    });
    return reply.send({
      lakes: rows.map((r) => ({ ...lakeView(r.lake, r.lake.profile?.content), isHome: r.isHome })),
    });
  });

  // The active (home) lake — what the app boots into.
  app.get('/api/me/active-lake', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const home = await ensureHomeLake(user.id);
    return reply.send({
      lake: home ? lakeView(home, home.profile?.content) : null,
      needsLake: !home,
    });
  });

  // "Show me the demo lake" from onboarding.
  app.post('/api/me/lakes/granbury', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const lake = await adoptGranbury(user.id);
    if (!lake) return reply.code(404).send({ error: 'The demo lake is not seeded on this server.' });
    return reply.send({ lake: lakeView(lake, lake.profile?.content) });
  });

  // Add an existing lake to my lakes.
  app.post('/api/me/lakes', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const lakeId = String((req.body as { lakeId?: string }).lakeId || '');
    const lake = await prisma.lake.findUnique({ where: { id: lakeId } });
    if (!lake) return reply.code(404).send({ error: 'Lake not found.' });
    await prisma.userLake.upsert({
      where: { userId_lakeId: { userId: user.id, lakeId } },
      create: { userId: user.id, lakeId },
      update: {},
    });
    return reply.send({ lake: lakeView(lake) });
  });

  // Set a lake as home (the one the app opens to).
  app.post('/api/me/lakes/:lakeId/home', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const lakeId = String((req.params as { lakeId: string }).lakeId);
    const mine = await prisma.userLake.findUnique({ where: { userId_lakeId: { userId: user.id, lakeId } } });
    if (!mine) return reply.code(404).send({ error: 'That lake is not in your list.' });
    await prisma.$transaction([
      prisma.userLake.updateMany({ where: { userId: user.id, isHome: true }, data: { isHome: false } }),
      prisma.userLake.update({ where: { userId_lakeId: { userId: user.id, lakeId } }, data: { isHome: true } }),
    ]);
    return reply.send({ ok: true });
  });

  // Remove a lake from my lakes (its per-user data stays under its KV namespace).
  app.delete('/api/me/lakes/:lakeId', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const lakeId = String((req.params as { lakeId: string }).lakeId);
    await prisma.userLake.deleteMany({ where: { userId: user.id, lakeId } });
    return reply.send({ ok: true });
  });

  // Boat ramps on this lake, from OpenStreetMap (cached 30 days per lake).
  app.get('/api/lakes/:id/ramps', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await overLimit(`ramps:${user.id}`, 30, 60_000)) {
      return reply.code(429).send({ error: 'Slow down a moment.' });
    }
    const { ramps, source } = await rampsForLake(String((req.params as { id: string }).id));
    return reply.send({ ramps, source });
  });

  /**
   * Dam release for this lake, if it sits below a Corps project.
   *
   * The planner has used this for a while; anglers could not see it. On a
   * regulated lake it is often the strongest single signal of the day — bait
   * moves with the current and fish set up on it — so it belongs on the water
   * page, not only inside a prompt.
   */
  app.get('/api/lakes/:id/release', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const id = String((req.params as { id: string }).id);
    const release = await releaseFor(id).catch(() => null);
    if (!release) return reply.send({ release: null });
    const last = release.readings[release.readings.length - 1];
    return reply.send({
      release: {
        project: release.project,
        units: release.units,
        generatingNow: release.generatingNow,
        latestCfs: last ? Math.round(last.cfs) : null,
        latestAt: last ? last.at : null,
        peakCfs: release.peakCfs ? Math.round(release.peakCfs) : null,
        hoursMoving: release.readings.filter((r: { cfs: number }) => r.cfs > 0).length,
        hoursSeen: release.readings.length,
        summary: summarizeRelease(release),
      },
    });
  });

  /**
   * Level and water temperature for this lake. The client used to ask USGS
   * directly for a parameter code that most lake gauges do not publish; the
   * server knows which code each gauge actually uses, and where to look when
   * there is no gauge at all. See services/water.ts.
   */
  app.get('/api/lakes/:id/water', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return reply.send(await waterFor(String((req.params as { id: string }).id)));
  });

  /**
   * Active National Weather Service alerts for this lake, plus the local
   * forecaster's own near-term reasoning. A Lake Wind Advisory is a reason not
   * to launch, not a number to weigh against cloud cover.
   */
  app.get('/api/lakes/:id/alerts', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const lake = await prisma.lake.findUnique({ where: { id: String((req.params as { id: string }).id) }, select: { lat: true, lon: true } });
    if (!lake) return reply.code(404).send({ error: 'Lake not found.' });
    const [alerts, discussion] = await Promise.all([
      alertsFor(lake.lat, lake.lon).catch(() => []),
      discussionFor(lake.lat, lake.lon).catch(() => null),
    ]);
    return reply.send({ alerts, discussion });
  });

  // Lake detail + its profile (AI or hand-verified).
  app.get('/api/lakes/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const id = String((req.params as { id: string }).id);
    const lake = await prisma.lake.findUnique({ where: { id }, include: { profile: true } });
    if (!lake) return reply.code(404).send({ error: 'Lake not found.' });
    return reply.send({
      lake: lakeView(lake, lake.profile?.content),
      profile: lake.profile
        ? { content: lake.profile.content, source: lake.profile.source, verified: lake.profile.verified }
        : null,
    });
  });
}

// Ensure the user has a home lake; seed Granbury as home the first time.
async function ensureHomeLake(userId: string) {
  const home = await prisma.userLake.findFirst({
    where: { userId, isHome: true },
    include: { lake: { include: { profile: { select: { content: true } } } } },
  });
  if (home) return home.lake;

  const any = await prisma.userLake.findFirst({
    where: { userId },
    include: { lake: { include: { profile: { select: { content: true } } } } },
    orderBy: { addedAt: 'asc' },
  });
  if (any) {
    await prisma.userLake.update({ where: { id: any.id }, data: { isHome: true } });
    return any.lake;
  }

  // A brand-new account gets NO lake. It used to be handed Granbury, which was
  // right when Granbury was the product and wrong now: someone signing up in
  // Florida would land on a Texas reservoir. The app onboards them instead —
  // `/api/me/active-lake` answers `lake: null, needsLake: true`.
  return null;
}

// Granbury on request only: the "just show me the app" escape hatch from the
// onboarding screen.
async function adoptGranbury(userId: string) {
  const granbury = await prisma.lake.findUnique({
    where: { osmRef: GRANBURY_OSM_REF },
    include: { profile: { select: { content: true } } },
  });
  if (!granbury) return null;
  await prisma.userLake.upsert({
    where: { userId_lakeId: { userId, lakeId: granbury.id } },
    create: { userId, lakeId: granbury.id, isHome: true },
    update: { isHome: true },
  });
  return granbury;
}

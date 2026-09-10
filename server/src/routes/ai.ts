import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { env } from '../env';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { getOrGenerateDayPlan } from '../services/dayPlan';
import { generateLakeProfile } from '../services/aiProfile';
import { identifyCatch } from '../services/identifyCatch';

const MAX_PHOTO_CHARS = 900_000; // ~670KB image (client resizes first)

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // Is the AI configured? Lets the UI show the right state.
  app.get('/api/ai/status', async () => ({ configured: !!process.env.ANTHROPIC_API_KEY }));

  // AI day planner: day + lake + target species -> hour-by-hour plan (cached,
  // regenerates as the day nears).
  // Cache-only read. Generation can outlive a phone's connection — the plan is
  // still written to the cache when it finishes, so a client that lost the
  // response can come back and collect it instead of burning another call.
  app.get('/api/ai/day-plan', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const q = req.query as { lakeId?: string; date?: string; species?: string };
    const lakeId = String(q.lakeId || ''), date = String(q.date || ''), species = String(q.species || '');
    if (!lakeId || !date || !species) return reply.code(400).send({ error: 'Need a lake, a date and a species.' });
    const cached = await prisma.dayPlan.findUnique({
      where: { lakeId_date_species: { lakeId, date, species } },
    });
    if (!cached) return reply.send({ ok: false, pending: true });
    return reply.send({
      ok: true, content: cached.content, generatedAt: cached.generatedAt,
      daysOutAtGen: cached.daysOutAtGen, source: 'cache',
    });
  });

  app.post('/api/ai/day-plan', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const b = (req.body || {}) as { lakeId?: string; date?: string; species?: string; conditions?: unknown; force?: boolean };
    // Only rate-limit calls that will actually hit the model.
    if (b.force && (await overLimit(`dayplan:${user.id}`, 30, 3600000))) {
      return reply.code(429).send({ error: 'Too many plan generations this hour — try again later.' });
    }
    const r = await getOrGenerateDayPlan({
      lakeId: String(b.lakeId || ''),
      date: String(b.date || ''),
      species: String(b.species || ''),
      conditions: b.conditions,
      force: !!b.force,
    });
    if (!r.ok) return reply.code(r.needsKey ? 503 : 400).send({ error: r.error, needsKey: r.needsKey });
    return reply.send(r);
  });

  // Identify a fish from a catch photo → species + size estimate (editable).
  app.post('/api/ai/identify-catch', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(503).send({ error: 'AI is not configured yet.', needsKey: true });
    const b = (req.body || {}) as { image?: string; lake?: string };
    const image = String(b.image || '');
    if (!image) return reply.code(400).send({ error: 'No photo provided.' });
    if (image.length > MAX_PHOTO_CHARS) return reply.code(413).send({ error: 'Photo too large — try again (it should auto-resize).' });
    if (await overLimit(`identify:${user.id}`, 40, 3600000)) {
      return reply.code(429).send({ error: 'Too many photo IDs this hour — try again later.' });
    }
    const r = await identifyCatch(image, { lake: b.lake ? String(b.lake).slice(0, 80) : undefined });
    if (!r.ok) return reply.code(r.needsKey ? 503 : 400).send({ error: r.error, needsKey: r.needsKey });
    return reply.send(r);
  });

  // (Re)generate the AI starter profile for a lake. Never overwrites Granbury's
  // hand-verified profile.
  app.post('/api/lakes/:id/profile/regenerate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(503).send({ error: 'AI is not configured yet.', needsKey: true });
    const id = String((req.params as { id: string }).id);
    const lake = await prisma.lake.findUnique({ where: { id }, include: { profile: true } });
    if (!lake) return reply.code(404).send({ error: 'Lake not found.' });
    if (lake.profile?.source === 'hand_verified') {
      return reply.send({ ok: true, skipped: 'hand_verified', profile: { content: lake.profile.content, source: lake.profile.source, verified: true } });
    }
    if (await overLimit(`profile:${user.id}`, 20, 3600000)) {
      return reply.code(429).send({ error: 'Too many guide generations this hour.' });
    }
    await generateLakeProfile(id);
    const p = await prisma.lakeProfile.findUnique({ where: { lakeId: id } });
    return reply.send({ ok: true, profile: p ? { content: p.content, source: p.source, verified: p.verified } : null });
  });
}

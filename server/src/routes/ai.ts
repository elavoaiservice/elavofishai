import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { env } from '../env';
import { requireUser } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import { getOrGenerateDayPlan } from '../services/dayPlan';
import { generateLakeProfile } from '../services/aiProfile';

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // Is the AI configured? Lets the UI show the right state.
  app.get('/api/ai/status', async () => ({ configured: !!env.anthropicApiKey }));

  // AI day planner: day + lake + target species -> hour-by-hour plan (cached,
  // regenerates as the day nears).
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

  // (Re)generate the AI starter profile for a lake. Never overwrites Granbury's
  // hand-verified profile.
  app.post('/api/lakes/:id/profile/regenerate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!env.anthropicApiKey) return reply.code(503).send({ error: 'AI is not configured yet.', needsKey: true });
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

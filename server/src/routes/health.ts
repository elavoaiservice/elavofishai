import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — never touches the DB.
  app.get('/health', async () => ({ status: 'ok', app: 'ElavoFishAI' }));

  // Readiness — verifies the DB is reachable.
  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok' };
    } catch {
      reply.code(503);
      return { status: 'degraded', db: 'down' };
    }
  });
}

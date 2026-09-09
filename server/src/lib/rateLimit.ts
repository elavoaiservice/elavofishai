import { prisma } from '../db';

// DB-backed fixed-window rate limiter. Bounded: one row per bucket, swept by age.
// Returns true when the caller is OVER the limit for this window.
export async function overLimit(bucket: string, max: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await prisma.rateLimit.findUnique({ where: { bucket } });
  if (!row || now - row.windowStart.getTime() > windowMs) {
    await prisma.rateLimit.upsert({
      where: { bucket },
      create: { bucket, count: 1, windowStart: new Date() },
      update: { count: 1, windowStart: new Date() },
    });
    return false;
  }
  if (row.count >= max) return true;
  await prisma.rateLimit.update({ where: { bucket }, data: { count: { increment: 1 } } });
  return false;
}

// Occasional sweep so abandoned buckets don't accumulate.
export async function sweepRateLimits(olderThanMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs);
  await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } });
}

import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db';

// Integration tests talk to a real Postgres — the sharing rules are mostly
// query shape, so an in-memory fake would test the fake. Point TEST_DATABASE_URL
// at a throwaway database (see `npm run test:db`); without it the integration
// suites skip rather than fail.
export const HAS_DB = !!process.env.TEST_DATABASE_URL;

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    const { buildApp } = await import('../src/index');
    app = await buildApp();
    await app.ready();
    // main() seeds the flagship lake at boot; buildApp() alone does not, and
    // anything that reaches for the demo lake needs it to exist.
    const { seedGranbury } = await import('../src/services/seed');
    await seedGranbury();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) await app.close();
  app = null;
  await prisma.$disconnect();
}

// Wipe everything the tests touch. CASCADE reaches further than the list —
// Lake carries an addedById FK to User, so truncating User takes Lake and its
// profile with it. Re-seed the demo lake afterwards, the way boot would.
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TournamentEntry","Tournament","Notification","ContentFlag","Invite","PostReaction","PostComment","Post","Listing","Photo","Waypoint","Spot","Trip","SharingPref","FriendGroupMember","FriendGroup",' +
      '"Friendship","Message","Session","AuthToken","RateLimit","Kv","UserLake","User" CASCADE'
  );
  const { seedGranbury } = await import('../src/services/seed');
  await seedGranbury();
}

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

// Sign a user in the way a real client does: request a magic link from a
// private-network address, then follow it.
export async function signIn(email: string): Promise<TestUser> {
  const a = await getApp();
  const req = await a.inject({
    method: 'POST',
    url: '/api/auth/request-link',
    payload: { email },
    remoteAddress: '127.0.0.1',
  });
  const { devLink } = req.json() as { devLink?: string };
  if (!devLink) throw new Error('no devLink — is DEV_SHOW_MAGIC_LINK set for tests?');
  const token = new URL(devLink).searchParams.get('token') as string;
  const verify = await a.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const cookie = String(verify.headers['set-cookie'] || '').split(';')[0];
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, email, cookie };
}

export async function makeLake(name = 'Test Lake'): Promise<string> {
  const lake = await prisma.lake.create({ data: { name, lat: 32.4, lon: -97.7, country: 'US' } });
  return lake.id;
}

export async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await prisma.friendship.create({
    data: { userId: a.id, friendId: b.id, requestedBy: a.id, status: 'accepted' },
  });
}

// Authenticated inject.
export async function as(
  user: TestUser,
  opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }
) {
  const a = await getApp();
  // Only claim a JSON body when there is one — Fastify's JSON parser rejects an
  // empty body sent with application/json, which is exactly how a body-less
  // POST/DELETE silently turns into a 400.
  const headers: Record<string, string> = { cookie: user.cookie };
  if (opts.payload !== undefined) headers['content-type'] = 'application/json';
  return a.inject({
    method: opts.method,
    url: opts.url,
    headers,
    payload: opts.payload as object | undefined,
  });
}

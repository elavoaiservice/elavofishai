// Prints one word for docker-start.sh to act on:
//   baseline — the schema exists but has no migration history (a database
//              created by the old `prisma db push` path): record 0001_init as
//              already applied instead of trying to re-create every table.
//   deploy   — a fresh or already-tracked database: just run migrate deploy.
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient({ log: [] });
  try {
    const [row] = await prisma.$queryRawUnsafe(
      // ::text — Prisma's raw client cannot deserialize a bare regclass.
      `SELECT to_regclass('public._prisma_migrations')::text AS history,
              to_regclass('public."User"')::text AS users`
    );
    console.log(!row.history && row.users ? 'baseline' : 'deploy');
  } catch (e) {
    // Can't tell → let migrate deploy speak for itself.
    console.error('[baseline] check failed:', e.message);
    console.log('deploy');
  } finally {
    await prisma.$disconnect();
  }
})();

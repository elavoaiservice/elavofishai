import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { env } from '../env';
import { requireUser } from '../lib/auth';

// Keys are namespaced by lake on the client (e.g. "<lakeId>:trips") plus a few
// global ones (e.g. "theme"). Allow ':' and generous length for the prefix.
const VALID_KEY = /^[\w:.\-]{1,120}$/;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export async function kvRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/kv/:key', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    let key: string;
    try {
      key = decodeURIComponent((req.params as { key: string }).key);
    } catch {
      return reply.code(400).send({ error: 'Bad key.' });
    }
    if (!VALID_KEY.test(key)) return reply.code(400).send({ error: 'Bad key.' });

    const row = await prisma.kv.findUnique({ where: { userId_key: { userId: user.id, key } } });
    if (!row) return reply.code(404).send({ error: 'empty' }); // 404 = "no data yet"
    return reply.send({ value: row.value });
  });

  app.put('/api/kv/:key', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    let key: string;
    try {
      key = decodeURIComponent((req.params as { key: string }).key);
    } catch {
      return reply.code(400).send({ error: 'Bad key.' });
    }
    if (!VALID_KEY.test(key)) return reply.code(400).send({ error: 'Bad key.' });

    // Body is the RAW value string (not JSON-wrapped). Accept string or, if a
    // JSON content-type slipped through, its serialized form.
    const raw = typeof req.body === 'string' ? req.body : req.body == null ? '' : JSON.stringify(req.body);
    if (byteLen(raw) > env.maxKeyBytes) {
      return reply.code(413).send({ error: 'That value is too large. 2 MB per key.' });
    }

    // Enforce per-user caps in a transaction so concurrent writes can't race past them.
    try {
      await prisma.$transaction(async (tx) => {
        // Counting bytes used to mean loading every stored value into Node on
        // every single write — up to 16 MB of text to decide whether 2 MB more
        // would fit. Postgres can add up octet_length without sending any of it.
        const [tally] = await tx.$queryRaw<{ others: bigint; otherbytes: bigint; mine: bigint }[]>`
          SELECT
            COUNT(*) FILTER (WHERE "key" <> ${key})::bigint AS others,
            COALESCE(SUM(octet_length("value")) FILTER (WHERE "key" <> ${key}), 0)::bigint AS otherbytes,
            COUNT(*) FILTER (WHERE "key" = ${key})::bigint AS mine
          FROM "Kv" WHERE "userId" = ${user.id}`;
        const others = Number(tally?.others || 0);
        const otherBytes = Number(tally?.otherbytes || 0);
        const isNew = Number(tally?.mine || 0) === 0;
        if (isNew && others >= env.maxKeysPerUser) {
          throw new Error('too_many_keys');
        }
        if (otherBytes + byteLen(raw) > env.maxUserBytes) {
          throw new Error('account_full');
        }
        await tx.kv.upsert({
          where: { userId_key: { userId: user.id, key } },
          create: { userId: user.id, key, value: raw },
          update: { value: raw },
        });
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'too_many_keys') return reply.code(409).send({ error: 'Too many stored keys on this account.' });
      if (msg === 'account_full') return reply.code(507).send({ error: 'Storage is full for this account.' });
      throw e;
    }
    return reply.send({ ok: true });
  });
}

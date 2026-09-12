/**
 * What an operator actually needs to know.
 *
 * The portal grew tab by tab as the app did, and measured what was easy rather
 * than what mattered: counts of users, lakes and key-value rows. None of that
 * answers the two questions an operator has — is anything broken right now,
 * and is the thing working? This module answers both.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../db';
import { storageConfigured } from './storage';
import { pushConfigured } from './push';
import { emailStatus } from './email';

export interface Attention {
  level: 'ok' | 'warn' | 'bad';
  title: string;
  detail: string;
  /** Which admin tab answers it. */
  tab?: string;
}

/**
 * Everything wanting a decision, in one list. Deliberately quiet when there is
 * nothing: a dashboard that always shows warnings trains people to ignore it.
 */
export async function attention(): Promise<Attention[]> {
  const out: Attention[] = [];
  const day = 86400_000;

  const [flags, failingSources, staleErrors, unpriced] = await Promise.all([
    prisma.contentFlag.count({ where: { status: 'open' } }).catch(() => 0),
    prisma.reportSource.count({ where: { active: true, lastError: { not: null } } }).catch(() => 0),
    prisma.clientError.count({ where: { createdAt: { gte: new Date(Date.now() - day) } } }).catch(() => 0),
    prisma.aiUsage.count({ where: { ok: false, createdAt: { gte: new Date(Date.now() - 7 * day) } } }).catch(() => 0),
  ]);

  if (flags) out.push({ level: 'warn', title: `${flags} report${flags === 1 ? '' : 's'} waiting`, detail: 'Someone flagged content and nobody has decided yet.', tab: 'flags' });
  if (failingSources) out.push({ level: 'warn', title: `${failingSources} report source${failingSources === 1 ? '' : 's'} failing`, detail: 'A feed is erroring, so those lakes are getting no agency reports.', tab: 'sources' });
  if (staleErrors > 20) out.push({ level: 'warn', title: `${staleErrors} client errors today`, detail: 'The app is throwing in someone’s browser — that is usually one bug, many times.', tab: 'errors' });
  if (unpriced > 5) out.push({ level: 'warn', title: `${unpriced} failed AI calls this week`, detail: 'Plans are failing to generate. Check the key and the model name.', tab: 'aicost' });

  // Backups: the only honest measure is when one last actually landed.
  const backup = latestBackup();
  if (!backup && backupVisible()) {
    out.push({ level: 'bad', title: 'No backup found', detail: 'Nothing in the backups directory. If this machine dies, everything goes with it.', tab: 'health' });
  } else if (!backup) {
    // We cannot see them rather than there being none. Say which, because
    // "no backup" and "cannot check" need completely different responses.
    out.push({ level: 'warn', title: 'Cannot see the backups', detail: 'Nothing reports backup status here yet. Run scripts/backup.sh once so it writes its status where the app can read it.', tab: 'health' });
  } else if (Date.now() - backup.at > 2 * day) {
    out.push({ level: 'bad', title: `Last backup is ${Math.round((Date.now() - backup.at) / day)} days old`, detail: 'The nightly job may have stopped. A backup nobody checks is a backup nobody has.', tab: 'health' });
  }

  if (!storageConfigured()) out.push({ level: 'warn', title: 'Photo storage is not configured', detail: 'Catch photos cannot be kept until R2 credentials are set.', tab: 'environment' });
  if (!pushConfigured()) out.push({ level: 'warn', title: 'Push notifications are off', detail: 'Without VAPID keys the bell only works while the app is open.', tab: 'environment' });
  const email = emailStatus();
  if (!email.configured) out.push({ level: 'bad', title: 'Email is not configured', detail: 'Nobody can sign in: the magic link has nowhere to go.', tab: 'environment' });
  else if (email.lastError) out.push({ level: 'bad', title: 'Email is failing', detail: `Last error: ${String(email.lastError).slice(0, 120)}`, tab: 'signin' });

  // Disk, because it fills up silently and then everything stops at once.
  try {
    const s = (fs as typeof fs & { statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number } }).statfsSync?.('/');
    if (s) {
      const usedPct = Math.round((1 - s.bavail / s.blocks) * 100);
      if (usedPct >= 90) out.push({ level: 'bad', title: `Disk is ${usedPct}% full`, detail: 'Postgres stops writing before it reaches 100%.', tab: 'health' });
      else if (usedPct >= 80) out.push({ level: 'warn', title: `Disk is ${usedPct}% full`, detail: 'Worth clearing old backups or images.', tab: 'health' });
    }
  } catch { /* not on a filesystem we can stat */ }

  return out;
}

const BACKUP_DIRS = ['/app/backups', path.resolve(process.cwd(), '../backups'), path.resolve(process.cwd(), 'backups')];
// The dumps live on the host and this runs in a container, so the usual answer
// is "cannot see them". backup.sh writes a one-line status into the volume both
// sides share; that file is the reliable source and the directories are a
// fallback for anyone running outside Docker.
const STATUS_FILE = path.join(process.env.DEPLOY_DIR || '/deploy', 'backup-status.json');

/** When a backup last actually succeeded — not when one was attempted. */
export function latestBackup(): { name: string; at: number; bytes: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as { at?: string; bytes?: number; name?: string };
    const at = Date.parse(String(raw.at || ''));
    if (Number.isFinite(at)) return { name: String(raw.name || 'backup'), at, bytes: Number(raw.bytes) || 0 };
  } catch { /* fall through to looking for the files themselves */ }

  for (const dir of BACKUP_DIRS) {
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.sql\.gz$/.test(f));
      if (!files.length) continue;
      const newest = files
        .map((f) => ({ name: f, ...fs.statSync(path.join(dir, f)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      return { name: newest.name, at: newest.mtimeMs, bytes: newest.size };
    } catch { /* try the next */ }
  }
  return null;
}

/** True when we have no way to see backups at all, as opposed to seeing none. */
export function backupVisible(): boolean {
  if (fs.existsSync(STATUS_FILE)) return true;
  return BACKUP_DIRS.some((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

/**
 * Does the product work? Counts say how much exists; this says whether people
 * get anywhere. Each step is "how many anglers who signed up ever did this",
 * so the gap between two steps is where they are being lost.
 */
export async function funnel(): Promise<{ step: string; n: number; pct: number }[]> {
  const users = await prisma.user.count({ where: { deletedAt: null } });
  if (!users) return [];
  const [withLake, withCatch, withPlan, withFriend, returned] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null, userLakes: { some: {} } } }),
    prisma.user.count({ where: { deletedAt: null, trips: { some: {} } } }),
    prisma.user.count({ where: { deletedAt: null, planRequests: { some: {} } } }),
    prisma.user.count({ where: { deletedAt: null, OR: [{ friendshipsInitiated: { some: { status: 'accepted' } } }, { friendshipsReceived: { some: { status: 'accepted' } } }] } }),
    // Came back at least a day after signing up — the only count that says the
    // app is worth opening twice.
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "User"
      WHERE "deletedAt" IS NULL AND "lastLoginAt" IS NOT NULL
        AND "lastLoginAt" > "createdAt" + interval '20 hours'`.then((r) => Number(r[0]?.n || 0)).catch(() => 0),
  ]);
  const pct = (n: number) => Math.round((n / users) * 100);
  return [
    { step: 'Signed up', n: users, pct: 100 },
    { step: 'Added a lake', n: withLake, pct: pct(withLake) },
    { step: 'Logged a catch', n: withCatch, pct: pct(withCatch) },
    { step: 'Asked for a plan', n: withPlan, pct: pct(withPlan) },
    { step: 'Has a crew', n: withFriend, pct: pct(withFriend) },
    { step: 'Came back another day', n: returned, pct: pct(returned) },
  ];
}

/** Everything the app now does, counted — including the parts the portal had never heard of. */
export async function featureCounts(): Promise<Record<string, number>> {
  const [posts, listings, tournaments, series, groups, invites, photos, pushSubs, readings, reports, messages, seasonsDone] =
    await Promise.all([
      prisma.post.count(), prisma.listing.count(), prisma.tournament.count(), prisma.tournamentSeries.count(),
      prisma.friendGroup.count(), prisma.invite.count(), prisma.photo.count(), prisma.pushSubscription.count(),
      prisma.waterReading.count(), prisma.lakeReport.count(), prisma.message.count(),
      prisma.tournament.count({ where: { status: 'done' } }),
    ]);
  return { posts, listings, tournaments, tournamentsFinished: seasonsDone, series, groups, invites, photos, pushSubs, readings, reports, messages };
}

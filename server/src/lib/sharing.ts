import { prisma } from '../db';

// Per-record visibility (what a Trip/Spot/Waypoint row carries) and the
// per-user default scope that fills it in when a client doesn't pick one.
export type Vis = 'private' | 'friends' | 'group' | 'public';
export const VIS: Vis[] = ['private', 'friends', 'group', 'public'];

export type DataType = 'trips' | 'spots' | 'waypoints';
export const DATA_TYPES: DataType[] = ['trips', 'spots', 'waypoints'];

export type Scope = 'none' | 'friends' | 'groups' | 'public';
export const SCOPES: Scope[] = ['none', 'friends', 'groups', 'public'];

export interface PrefRow {
  scope: Scope;
  groupIds: string[];
}
export type Prefs = Record<DataType, PrefRow>;

// What a user gets before they ever open the sharing settings. Matches what the
// share forms have always preselected — an explicit `none` is how you opt into
// private-by-default.
const FALLBACK: PrefRow = { scope: 'friends', groupIds: [] };

// Group ids the user owns or belongs to.
export async function myGroupIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    prisma.friendGroup.findMany({ where: { ownerId: userId }, select: { id: true } }),
    prisma.friendGroupMember.findMany({ where: { memberId: userId, status: 'active' }, select: { groupId: true } }),
  ]);
  return [...owned.map((g) => g.id), ...member.map((m) => m.groupId)];
}

export async function getPrefs(userId: string): Promise<Prefs> {
  const rows = await prisma.sharingPref.findMany({ where: { userId } });
  const out = {} as Prefs;
  for (const t of DATA_TYPES) {
    const row = rows.find((r) => r.dataType === t);
    out[t] = row ? { scope: row.scope as Scope, groupIds: row.groupIds } : { ...FALLBACK };
  }
  return out;
}

// Save any subset of the three data types. Group ids are filtered to groups the
// user actually owns or belongs to, so a stale id can't widen sharing later.
export async function savePrefs(userId: string, input: Partial<Record<DataType, PrefRow>>): Promise<Prefs> {
  const mine = await myGroupIds(userId);
  for (const t of DATA_TYPES) {
    const want = input[t];
    if (!want) continue;
    const scope: Scope = SCOPES.includes(want.scope) ? want.scope : 'none';
    const groupIds = scope === 'groups' ? (want.groupIds || []).filter((g) => mine.includes(g)) : [];
    if (scope === 'groups' && !groupIds.length) {
      throw new Error('no_groups');
    }
    await prisma.sharingPref.upsert({
      where: { userId_dataType: { userId, dataType: t } },
      create: { userId, dataType: t, scope, groupIds },
      update: { scope, groupIds },
    });
  }
  return getPrefs(userId);
}

// The user's default, expressed as a record-level visibility.
export async function defaultVisibility(
  userId: string,
  dataType: DataType
): Promise<{ visibility: Vis; groupId: string | null }> {
  const prefs = await getPrefs(userId);
  const pref = prefs[dataType];
  switch (pref.scope) {
    case 'none':
      return { visibility: 'private', groupId: null };
    case 'public':
      return { visibility: 'public', groupId: null };
    case 'groups':
      // A record lives in exactly one group; the first configured group is the
      // default and the share form still lets you pick another.
      return pref.groupIds.length
        ? { visibility: 'group', groupId: pref.groupIds[0] }
        : { visibility: 'friends', groupId: null };
    default:
      return { visibility: 'friends', groupId: null };
  }
}

// Resolve what a create request should store. No visibility supplied → the
// user's default for that data type. Throws `bad_group` for a group the user
// isn't part of.
export async function resolveVisibility(
  userId: string,
  dataType: DataType,
  requested?: string,
  groupId?: string
): Promise<{ visibility: Vis; groupId: string | null }> {
  if (!requested || requested === 'default') return defaultVisibility(userId, dataType);
  const visibility = (VIS as string[]).includes(requested) ? (requested as Vis) : 'friends';
  if (visibility !== 'group') return { visibility, groupId: null };
  if (!groupId || !(await myGroupIds(userId)).includes(groupId)) throw new Error('bad_group');
  return { visibility, groupId };
}

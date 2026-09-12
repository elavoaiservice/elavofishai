/**
 * What a member actually shares with a group.
 *
 * Two separate decisions have to line up before a record reaches a group:
 *   1. the record itself carries `visibility: 'group'` and that group's id, and
 *   2. the member has not switched that kind of data off for that group.
 *
 * (2) is the veto an angler is given when they accept an invitation, and it is
 * enforced here rather than in each query — a spot that shows up because one
 * feed forgot the rule is exactly the failure the whole product is judged on.
 */
import { prisma } from '../db';
import type { DataType } from './sharing';

const COLUMN: Record<DataType, 'shareSpots' | 'shareCatches' | 'shareWaypoints'> = {
  spots: 'shareSpots',
  trips: 'shareCatches',
  waypoints: 'shareWaypoints',
};

export interface GroupClause {
  visibility: 'group';
  groupId: string;
  userId: { in: string[] };
}

/**
 * One clause per group the viewer belongs to, naming exactly the members who
 * share that data type with it. The owner is always included: they are sharing
 * with their own group, and a per-record `visibility: group` is already their
 * explicit choice.
 *
 * Returns [] when the viewer is in no groups — callers must treat that as "no
 * group-shared records", not "no filter".
 */
export async function groupClauses(viewerId: string, type: DataType, blocked: string[] = []): Promise<GroupClause[]> {
  const [owned, memberships] = await Promise.all([
    prisma.friendGroup.findMany({ where: { ownerId: viewerId }, select: { id: true } }),
    prisma.friendGroupMember.findMany({
      where: { memberId: viewerId, status: 'active' },
      select: { groupId: true },
    }),
  ]);
  const groupIds = [...new Set([...owned.map((g) => g.id), ...memberships.map((m) => m.groupId)])];
  if (!groupIds.length) return [];

  const [groups, sharers] = await Promise.all([
    prisma.friendGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, ownerId: true, dataSharing: true } }),
    prisma.friendGroupMember.findMany({
      where: { groupId: { in: groupIds }, status: 'active', [COLUMN[type]]: true },
      select: { groupId: true, memberId: true },
    }),
  ]);

  const byGroup = new Map<string, string[]>();
  for (const g of groups) {
    // A group set to "off" shares nothing, whatever its members ticked: the
    // owner's setting is the outer bound, not a suggestion.
    if (g.dataSharing === 'off') continue;
    byGroup.set(g.id, [g.ownerId]);
  }
  for (const s of sharers) {
    const list = byGroup.get(s.groupId);
    if (list) list.push(s.memberId);
  }

  return [...byGroup.entries()]
    .map(([groupId, users]) => ({
      visibility: 'group' as const,
      groupId,
      // A blocked angler is invisible even inside a shared group.
      userId: { in: [...new Set(users)].filter((id) => id !== viewerId && !blocked.includes(id)) },
    }))
    .filter((c) => c.userId.in.length > 0);
}

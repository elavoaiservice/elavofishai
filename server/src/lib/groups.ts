/**
 * Who can do what on a group's page.
 *
 * Four roles, in order of power. The owner is stored on FriendGroup (there is
 * exactly one, and the group dies with them); the rest live on the membership
 * row:
 *
 *   owner        rename, delete, set anyone's role, remove anyone, moderate
 *   editor       invite and remove members, moderate posts, post
 *   collaborator post to the page
 *   member       read the page and comment
 *
 * Every check is a query, not a cached claim: a role revoked a second ago has
 * to take effect on the next request, and the only place that is reliably true
 * is the database.
 */
import { prisma } from '../db';

export type GroupRole = 'owner' | 'editor' | 'collaborator' | 'member';
export const GROUP_ROLES: GroupRole[] = ['owner', 'editor', 'collaborator', 'member'];
/** Roles an owner or editor may hand out. Ownership transfer is its own move. */
export const ASSIGNABLE: GroupRole[] = ['editor', 'collaborator', 'member'];

const RANK: Record<GroupRole, number> = { owner: 3, editor: 2, collaborator: 1, member: 0 };

/** The viewer's role in a group, or null if they are not in it at all. */
export async function roleIn(groupId: string, userId: string): Promise<GroupRole | null> {
  const group = await prisma.friendGroup.findUnique({ where: { id: groupId }, select: { ownerId: true } });
  if (!group) return null;
  if (group.ownerId === userId) return 'owner';
  const m = await prisma.friendGroupMember.findFirst({
    where: { groupId, memberId: userId },
    select: { role: true },
  });
  if (!m) return null;
  return (GROUP_ROLES as string[]).includes(m.role) ? (m.role as GroupRole) : 'member';
}

export function atLeast(role: GroupRole | null, min: GroupRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

export const canRead = (role: GroupRole | null): boolean => role !== null;
export const canPost = (role: GroupRole | null): boolean => atLeast(role, 'collaborator');
export const canModerate = (role: GroupRole | null): boolean => atLeast(role, 'editor');
export const canManageMembers = (role: GroupRole | null): boolean => atLeast(role, 'editor');
/** Only the owner may rename, delete, or change what an editor can do. */
export const canAdminister = (role: GroupRole | null): boolean => role === 'owner';

/**
 * Can `actor` change `target`'s role to `next`?
 *
 * An editor runs day-to-day membership but cannot make another editor, promote
 * themselves, or touch an existing editor — otherwise "editor" is just "owner"
 * with an extra step.
 */
export function canSetRole(actorRole: GroupRole | null, targetRole: GroupRole | null, next: GroupRole): boolean {
  if (!ASSIGNABLE.includes(next)) return false;
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  if (actorRole !== 'editor') return false;
  return targetRole !== 'editor' && next !== 'editor';
}

/** Same shape for removal: an editor may remove members and collaborators only. */
export function canRemoveMember(actorRole: GroupRole | null, targetRole: GroupRole | null): boolean {
  if (targetRole === 'owner' || targetRole === null) return false;
  if (actorRole === 'owner') return true;
  if (actorRole !== 'editor') return false;
  return targetRole !== 'editor';
}

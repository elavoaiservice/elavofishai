-- Group membership becomes an invitation, groups get owner-set settings, and
-- a group can run a tournament.

-- Existing members are already in; only new invitations start pending. Their
-- share flags default to true so nothing anyone is sharing today goes dark.
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "invitedById" TEXT;
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "invitedAt" TIMESTAMP(3);
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "shareSpots" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "shareCatches" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "shareWaypoints" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS "FriendGroupMember_memberId_status_idx" ON "FriendGroupMember"("memberId", "status");

ALTER TABLE "FriendGroup" ADD COLUMN IF NOT EXISTS "dataSharing" TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE "FriendGroup" ADD COLUMN IF NOT EXISTS "whoCanInvite" TEXT NOT NULL DEFAULT 'editors';

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "tournamentId" TEXT;

CREATE TABLE IF NOT EXISTS "Tournament" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT,
    "lakeId" TEXT,
    "meetAt" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "species" TEXT,
    "format" TEXT NOT NULL DEFAULT 'heaviest_bag',
    "entryFee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Tournament_groupId_startsAt_idx" ON "Tournament"("groupId", "startsAt");
ALTER TABLE "Tournament" DROP CONSTRAINT IF EXISTS "Tournament_groupId_fkey";
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "FriendGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Tournament" DROP CONSTRAINT IF EXISTS "Tournament_hostId_fkey";
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Tournament" DROP CONSTRAINT IF EXISTS "Tournament_lakeId_fkey";
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_lakeId_fkey"
  FOREIGN KEY ("lakeId") REFERENCES "Lake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TournamentEntry" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TournamentEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TournamentEntry_tournamentId_userId_key" ON "TournamentEntry"("tournamentId", "userId");
CREATE INDEX IF NOT EXISTS "TournamentEntry_userId_status_idx" ON "TournamentEntry"("userId", "status");
ALTER TABLE "TournamentEntry" DROP CONSTRAINT IF EXISTS "TournamentEntry_tournamentId_fkey";
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TournamentEntry" DROP CONSTRAINT IF EXISTS "TournamentEntry_userId_fkey";
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

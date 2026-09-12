-- A per-angler default audience for posts (friends unless opened up), and
-- catches that can be entered into a tournament.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "postDefault" TEXT NOT NULL DEFAULT 'friends';
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "tournamentId" TEXT;
CREATE INDEX IF NOT EXISTS "Trip_tournamentId_idx" ON "Trip"("tournamentId");
ALTER TABLE "Trip" DROP CONSTRAINT IF EXISTS "Trip_tournamentId_fkey";
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "resultsNote" TEXT;

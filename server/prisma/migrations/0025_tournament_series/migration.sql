-- Seasons: a series of tournaments with standings, drops and an angler of the
-- year. Every club trail runs this on a spreadsheet today.
CREATE TABLE IF NOT EXISTS "TournamentSeries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "details" TEXT,
    "scoring" TEXT NOT NULL DEFAULT 'points',
    "pointsTop" INTEGER NOT NULL DEFAULT 100,
    "pointsStep" INTEGER NOT NULL DEFAULT 1,
    "dropWorst" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TournamentSeries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TournamentSeries_groupId_year_idx" ON "TournamentSeries"("groupId", "year");
ALTER TABLE "TournamentSeries" DROP CONSTRAINT IF EXISTS "TournamentSeries_groupId_fkey";
ALTER TABLE "TournamentSeries" ADD CONSTRAINT "TournamentSeries_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "FriendGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "seriesId" TEXT;
CREATE INDEX IF NOT EXISTS "Tournament_seriesId_idx" ON "Tournament"("seriesId");
ALTER TABLE "Tournament" DROP CONSTRAINT IF EXISTS "Tournament_seriesId_fkey";
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "TournamentSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

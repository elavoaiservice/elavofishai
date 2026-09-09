-- Waypoints can now be shared with a single friend group, the same way spots
-- and catches already could. IF NOT EXISTS so a database baselined from the old
-- `prisma db push` path (where the column may already be present) still applies.
ALTER TABLE "Waypoint" ADD COLUMN IF NOT EXISTS "groupId" TEXT;

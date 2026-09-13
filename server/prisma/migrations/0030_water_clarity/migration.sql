-- Water clarity from the EPA Water Quality Portal. Stored as the raw Secchi
-- readings so the same cache can answer for any month, plus the time we last
-- asked — which is stamped even when the portal has nothing, so a lake it does
-- not cover is not re-queried on every page load.
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "clarityJson" TEXT;
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "clarityAt" TIMESTAMP(3);

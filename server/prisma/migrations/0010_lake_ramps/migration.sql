-- Boat ramps from OpenStreetMap, cached per lake. Overpass is a shared
-- volunteer service, so we ask it once a month per lake, not once per plan.
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "rampsJson" TEXT;
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "rampsAt" TIMESTAMP(3);

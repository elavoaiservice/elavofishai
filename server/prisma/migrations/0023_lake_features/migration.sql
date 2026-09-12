-- Named, coordinate-bearing features on a lake (creek mouths, points, bridges,
-- dams, piers, marinas) from OpenStreetMap, cached per lake so the planner can
-- put its stops on a map without inventing coordinates.
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "featuresJson" TEXT;
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "featuresAt" TIMESTAMP(3);

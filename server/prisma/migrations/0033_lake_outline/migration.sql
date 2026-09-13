-- The lake's closed outline rings, stitched from the OSM member ways.
--
-- Stored because more than one thing needs to ask "is this point in the
-- water": lake features already did it inline, but boat ramps come from a
-- separate Overpass query and were never checked at all — an `out center`
-- coordinate on a slipway is the middle of its bounding box, which is the
-- parking lot. Those ramps went into the planner's candidate list as-is, and
-- with the feature cache cleared by 0032 they were most of what the planner
-- had to choose from, which is how waypoints kept landing off the water.
--
-- Keeping the rings on the row means the ramp guard costs a read rather than a
-- second trip to Overpass, which is already rate-limiting us.
ALTER TABLE "Lake" ADD COLUMN "outlineJson" TEXT;
ALTER TABLE "Lake" ADD COLUMN "outlineAt" TIMESTAMP(3);

-- Ramps cached before the guard existed hold unguarded coordinates. Drop the
-- timestamp so they refetch and pass through it.
UPDATE "Lake" SET "rampsAt" = NULL;

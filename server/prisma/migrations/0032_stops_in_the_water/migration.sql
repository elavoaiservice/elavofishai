-- Cached features still hold coordinates snapped to the shoreline, which is
-- the bank. Measured against the real Lake Granbury polygon, every stop in a
-- generated plan was outside the water. Stops are now placed IN the water, so
-- every cached list has to be rebuilt.
--
-- The JSON goes too this time, not just the stamp: the fallback that serves a
-- cached list when Overpass is busy would otherwise keep handing back the
-- coordinates this migration exists to replace. No stops beats wrong stops.
UPDATE "Lake" SET "featuresAt" = NULL, "featuresJson" = NULL;

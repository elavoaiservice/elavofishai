-- "Lake Fork" pointed at the wrong water.
--
-- The row was seeded from way/507602759, which really is named "Lake Fork" in
-- OSM — a 36-node pond at 32.447,-95.687 whose outline spans 1.0 x 1.6 km.
-- The lake anglers mean is relation/2130134, "Lake Fork Reservoir", 49 km
-- north at 32.886,-95.642, spanning 21 x 25 km. Lake search matched the pond
-- because the names tie and nothing preferred the larger body; that is a
-- separate fix. This repairs the row.
--
-- Keyed on the bad osmRef so it is a no-op in any database that never had it.
-- The name stays "Lake Fork" — that is what anglers call it, and the Overpass
-- query keys off the "Fork" token either way.
UPDATE "Lake"
SET "lat"    = 32.8860027,
    "lon"    = -95.6420093,
    "osmRef" = 'relation/2130134',
    "bbox"   = '["32.7919312","32.9800768","-95.7515942","-95.47805"]',
    -- Every one of these was derived from the pond's location. Unlike 0033 and
    -- 0034, clearing featuresAt here is the right thing: the cached features
    -- belong to a different body of water, so serving them as the
    -- last-good-cache fallback would be worse than offering nothing.
    "featuresJson" = NULL, "featuresAt" = NULL,
    "outlineJson"  = NULL, "outlineAt"  = NULL,
    "rampsJson"    = NULL, "rampsAt"    = NULL,
    "clarityJson"  = NULL, "clarityAt"  = NULL,
    "corpsProject" = NULL, "corpsAt"    = NULL
WHERE "osmRef" = 'way/507602759'
  AND NOT EXISTS (SELECT 1 FROM "Lake" WHERE "osmRef" = 'relation/2130134');

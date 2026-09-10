-- A plan for numbers and a plan for one big fish are different plans, so the
-- goal belongs in the cache key. Existing rows were all numbers-style.
ALTER TABLE "DayPlan" ADD COLUMN IF NOT EXISTS "goal" TEXT NOT NULL DEFAULT 'numbers';
DROP INDEX IF EXISTS "DayPlan_lakeId_date_species_key";
CREATE UNIQUE INDEX IF NOT EXISTS "DayPlan_lakeId_date_species_goal_key"
  ON "DayPlan"("lakeId", "date", "species", "goal");

-- Species names were briefly stored HTML-escaped; make old rows match what the
-- app now sends so they are still cache hits rather than orphans.
UPDATE "DayPlan" SET species = replace(species, '&amp;', '&') WHERE species LIKE '%&amp;%';

-- What the weather was doing when a fish ate; the rules for each water; and a
-- day-by-day record of level and temperature so they can be drawn as a trend.
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "waterTempF" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "airTempF" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "pressureTrend" TEXT;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "windMph" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "windDir" INTEGER;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "moonPct" INTEGER;

ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "regsJson" TEXT;
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "regsAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "WaterReading" (
    "id" TEXT NOT NULL,
    "lakeId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "levelFt" DOUBLE PRECISION,
    "tempF" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    CONSTRAINT "WaterReading_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WaterReading_lakeId_at_key" ON "WaterReading"("lakeId", "at");
CREATE INDEX IF NOT EXISTS "WaterReading_lakeId_at_idx" ON "WaterReading"("lakeId", "at");
ALTER TABLE "WaterReading" DROP CONSTRAINT IF EXISTS "WaterReading_lakeId_fkey";
ALTER TABLE "WaterReading" ADD CONSTRAINT "WaterReading_lakeId_fkey"
  FOREIGN KEY ("lakeId") REFERENCES "Lake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

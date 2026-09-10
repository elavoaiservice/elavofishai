-- A coordinate index of USACE projects, so finding the nearest one is a
-- distance query rather than a guess about which district a state belongs to.
CREATE TABLE IF NOT EXISTS "CorpsLocation" (
    "id" TEXT NOT NULL,
    "office" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicName" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CorpsLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CorpsLocation_office_name_key" ON "CorpsLocation"("office", "name");
CREATE INDEX IF NOT EXISTS "CorpsLocation_lat_lon_idx" ON "CorpsLocation"("lat", "lon");

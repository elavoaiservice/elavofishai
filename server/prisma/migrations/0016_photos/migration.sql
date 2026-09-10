-- Catch photos. The bytes live in object storage; this table is the permission
-- record, so a photo inherits the visibility of the catch it belongs to.
CREATE TABLE IF NOT EXISTS "Photo" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tripId" TEXT,
    "lakeId" TEXT,
    "mediaType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Photo_key_key" ON "Photo"("key");
CREATE INDEX IF NOT EXISTS "Photo_tripId_idx" ON "Photo"("tripId");
CREATE INDEX IF NOT EXISTS "Photo_userId_createdAt_idx" ON "Photo"("userId", "createdAt");
ALTER TABLE "Photo" DROP CONSTRAINT IF EXISTS "Photo_userId_fkey";
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Photo" DROP CONSTRAINT IF EXISTS "Photo_tripId_fkey";
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

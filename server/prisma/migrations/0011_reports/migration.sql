-- Fishing reports: official agency feeds, fetched pages, and anglers who were
-- actually on the water. These feed the day planner.
CREATE TABLE IF NOT EXISTS "LakeReport" (
    "id" TEXT NOT NULL,
    "lakeId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceName" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LakeReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LakeReport_lakeId_publishedAt_idx" ON "LakeReport"("lakeId", "publishedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "LakeReport_lakeId_url_key" ON "LakeReport"("lakeId", "url");
ALTER TABLE "LakeReport" DROP CONSTRAINT IF EXISTS "LakeReport_lakeId_fkey";
ALTER TABLE "LakeReport" ADD CONSTRAINT "LakeReport_lakeId_fkey"
  FOREIGN KEY ("lakeId") REFERENCES "Lake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LakeReport" DROP CONSTRAINT IF EXISTS "LakeReport_userId_fkey";
ALTER TABLE "LakeReport" ADD CONSTRAINT "LakeReport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ReportSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'rss',
    "lakeId" TEXT,
    "region" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReportSource_active_idx" ON "ReportSource"("active");

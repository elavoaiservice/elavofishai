-- Classifieds. Visible to every signed-in angler, so there is no visibility
-- column — only a status, and a bumpedAt so re-listing doesn't have to lie
-- about when the ad was written.
CREATE TABLE IF NOT EXISTS "Listing" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "category" TEXT NOT NULL DEFAULT 'other',
    "condition" TEXT,
    "location" TEXT,
    "lakeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bumpedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Listing_status_bumpedAt_idx" ON "Listing"("status", "bumpedAt");
CREATE INDEX IF NOT EXISTS "Listing_sellerId_idx" ON "Listing"("sellerId");
CREATE INDEX IF NOT EXISTS "Listing_category_status_idx" ON "Listing"("category", "status");
ALTER TABLE "Listing" DROP CONSTRAINT IF EXISTS "Listing_sellerId_fkey";
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Listing" DROP CONSTRAINT IF EXISTS "Listing_lakeId_fkey";
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_lakeId_fkey"
  FOREIGN KEY ("lakeId") REFERENCES "Lake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "listingId" TEXT;
CREATE INDEX IF NOT EXISTS "Photo_listingId_idx" ON "Photo"("listingId");
ALTER TABLE "Photo" DROP CONSTRAINT IF EXISTS "Photo_listingId_fkey";
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

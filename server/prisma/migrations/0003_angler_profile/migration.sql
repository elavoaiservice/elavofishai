-- Angler profile fields captured during first-run onboarding. All optional:
-- hasBoat is nullable so "never asked" stays distinct from "no boat".
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "favoriteLure" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hasBoat" BOOLEAN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "boatType" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "yearsFishing" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3);

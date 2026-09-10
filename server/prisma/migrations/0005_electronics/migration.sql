-- What electronics the angler runs. The app assumed Garmin + LiveScope
-- throughout; these let it match the boat instead. NULL = never asked, which
-- stays distinct from 'none' = fishes without.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "plotterBrand" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ffsBrand" TEXT;

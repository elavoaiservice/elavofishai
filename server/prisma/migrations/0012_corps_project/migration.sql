-- Nearest USACE project for a lake ("OFFICE:LOCATION"), so dam releases and
-- hydropower generation can be read. An empty string means "looked, none near"
-- and stops us searching every district again.
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "corpsProject" TEXT;
ALTER TABLE "Lake" ADD COLUMN IF NOT EXISTS "corpsAt" TIMESTAMP(3);

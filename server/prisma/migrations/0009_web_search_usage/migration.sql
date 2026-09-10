-- Server-side web searches are billed per search ($10 / 1,000) on top of
-- tokens, so they are counted alongside them.
ALTER TABLE "AiUsage" ADD COLUMN IF NOT EXISTS "webSearches" INTEGER NOT NULL DEFAULT 0;

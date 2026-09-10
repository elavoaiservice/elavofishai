-- Per-call AI usage and cost, so spend is visible before the invoice is.
CREATE TABLE IF NOT EXISTS "AiUsage" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userId" TEXT,
    "lakeId" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_feature_createdAt_idx" ON "AiUsage"("feature", "createdAt");

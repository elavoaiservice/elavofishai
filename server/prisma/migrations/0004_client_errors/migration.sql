-- Client-side JS errors reported by the app, so a broken deploy is visible to
-- an admin instead of only to the angler whose screen went blank.
CREATE TABLE IF NOT EXISTS "ClientError" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT,
    "stack" TEXT,
    "url" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientError_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ClientError_createdAt_idx" ON "ClientError"("createdAt");

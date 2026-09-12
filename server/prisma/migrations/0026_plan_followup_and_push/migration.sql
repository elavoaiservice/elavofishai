-- Who asked for a plan (so we can ask them afterwards how it went), and which
-- browsers want to be told when something happens.
CREATE TABLE IF NOT EXISTS "PlanRequest" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lakeId" TEXT NOT NULL,
    "forDate" TIMESTAMP(3) NOT NULL,
    "askedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlanRequest_planId_userId_key" ON "PlanRequest"("planId", "userId");
CREATE INDEX IF NOT EXISTS "PlanRequest_userId_forDate_idx" ON "PlanRequest"("userId", "forDate");
ALTER TABLE "PlanRequest" DROP CONSTRAINT IF EXISTS "PlanRequest_planId_fkey";
ALTER TABLE "PlanRequest" ADD CONSTRAINT "PlanRequest_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "DayPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanRequest" DROP CONSTRAINT IF EXISTS "PlanRequest_userId_fkey";
ALTER TABLE "PlanRequest" ADD CONSTRAINT "PlanRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");
ALTER TABLE "PushSubscription" DROP CONSTRAINT IF EXISTS "PushSubscription_userId_fkey";
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

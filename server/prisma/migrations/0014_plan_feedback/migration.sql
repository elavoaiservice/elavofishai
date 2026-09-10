-- Was the plan any good? The app measures its inputs thoroughly and its output
-- not at all; this is the fix. Stamped with the model so model choice can be
-- judged on results rather than price alone.
CREATE TABLE IF NOT EXISTS "PlanFeedback" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "note" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlanFeedback_planId_userId_key" ON "PlanFeedback"("planId", "userId");
CREATE INDEX IF NOT EXISTS "PlanFeedback_model_helpful_idx" ON "PlanFeedback"("model", "helpful");
ALTER TABLE "PlanFeedback" DROP CONSTRAINT IF EXISTS "PlanFeedback_planId_fkey";
ALTER TABLE "PlanFeedback" ADD CONSTRAINT "PlanFeedback_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "DayPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanFeedback" DROP CONSTRAINT IF EXISTS "PlanFeedback_userId_fkey";
ALTER TABLE "PlanFeedback" ADD CONSTRAINT "PlanFeedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

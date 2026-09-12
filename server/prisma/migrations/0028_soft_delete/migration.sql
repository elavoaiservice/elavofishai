-- Deleting an angler used to cascade everything instantly. Now it is marked
-- and scheduled, so there is a window to undo it and something left to export.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "scheduledDeleteAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "User_scheduledDeleteAt_idx" ON "User"("scheduledDeleteAt");

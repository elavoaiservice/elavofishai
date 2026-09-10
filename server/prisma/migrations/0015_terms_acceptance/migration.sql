-- Record that someone accepted the terms, and which version — "they agreed"
-- is only meaningful if you can say what they agreed to.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;

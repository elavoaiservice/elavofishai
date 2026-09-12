-- Remember which invite a signup came through, so only a real invite link
-- creates a friendship.
ALTER TABLE "AuthToken" ADD COLUMN IF NOT EXISTS "inviteCode" TEXT;

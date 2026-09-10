-- Notifications, flags, and invites.
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "groupId" TEXT,
    "listingId" TEXT,
    "snippet" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_userId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_actorId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ContentFlag" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentFlag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContentFlag_status_createdAt_idx" ON "ContentFlag"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ContentFlag_targetType_targetId_idx" ON "ContentFlag"("targetType", "targetId");
CREATE UNIQUE INDEX IF NOT EXISTS "ContentFlag_reporterId_targetType_targetId_key"
  ON "ContentFlag"("reporterId", "targetType", "targetId");
ALTER TABLE "ContentFlag" DROP CONSTRAINT IF EXISTS "ContentFlag_reporterId_fkey";
ALTER TABLE "ContentFlag" ADD CONSTRAINT "ContentFlag_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "Invite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_code_key" ON "Invite"("code");
CREATE INDEX IF NOT EXISTS "Invite_inviterId_createdAt_idx" ON "Invite"("inviterId", "createdAt");
CREATE INDEX IF NOT EXISTS "Invite_email_idx" ON "Invite"("email");
ALTER TABLE "Invite" DROP CONSTRAINT IF EXISTS "Invite_inviterId_fkey";
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_inviterId_fkey"
  FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invite" DROP CONSTRAINT IF EXISTS "Invite_acceptedById_fkey";
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A post that has been edited says so.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);

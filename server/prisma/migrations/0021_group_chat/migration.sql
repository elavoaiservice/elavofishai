-- Group chat. A message now goes either to one angler or to a group; the
-- column that was NOT NULL becomes nullable so a group message can exist
-- without a single recipient.
ALTER TABLE "Message" ALTER COLUMN "recipientId" DROP NOT NULL;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Message_groupId_createdAt_idx" ON "Message"("groupId", "createdAt");
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_groupId_fkey";
ALTER TABLE "Message" ADD CONSTRAINT "Message_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "FriendGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "Read" in a group is per member, not per message: one row per member moves
-- forward instead of a read receipt per message per person.
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "chatReadAt" TIMESTAMP(3);

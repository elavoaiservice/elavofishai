-- Walls: a post is what an angler says on their own page or on a group's page.
-- Group posts take their audience from the group; everything else carries its
-- own visibility, the same three words the rest of the app uses.
CREATE TABLE IF NOT EXISTS "Post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "groupId" TEXT,
    "lakeId" TEXT,
    "body" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'friends',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Post_authorId_createdAt_idx" ON "Post"("authorId", "createdAt");
CREATE INDEX IF NOT EXISTS "Post_groupId_createdAt_idx" ON "Post"("groupId", "createdAt");
ALTER TABLE "Post" DROP CONSTRAINT IF EXISTS "Post_authorId_fkey";
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Post" DROP CONSTRAINT IF EXISTS "Post_groupId_fkey";
ALTER TABLE "Post" ADD CONSTRAINT "Post_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "FriendGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Post" DROP CONSTRAINT IF EXISTS "Post_lakeId_fkey";
ALTER TABLE "Post" ADD CONSTRAINT "Post_lakeId_fkey"
  FOREIGN KEY ("lakeId") REFERENCES "Lake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PostComment_postId_createdAt_idx" ON "PostComment"("postId", "createdAt");
ALTER TABLE "PostComment" DROP CONSTRAINT IF EXISTS "PostComment_postId_fkey";
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" DROP CONSTRAINT IF EXISTS "PostComment_authorId_fkey";
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PostReaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'like',
    CONSTRAINT "PostReaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PostReaction_postId_userId_key" ON "PostReaction"("postId", "userId");
ALTER TABLE "PostReaction" DROP CONSTRAINT IF EXISTS "PostReaction_postId_fkey";
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostReaction" DROP CONSTRAINT IF EXISTS "PostReaction_userId_fkey";
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A photo can hang on a post as well as on a catch.
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "postId" TEXT;
CREATE INDEX IF NOT EXISTS "Photo_postId_idx" ON "Photo"("postId");
ALTER TABLE "Photo" DROP CONSTRAINT IF EXISTS "Photo_postId_fkey";
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Group roles. Everyone already in a group keeps the read-and-comment role;
-- the owner stays the owner by way of FriendGroup.ownerId.
ALTER TABLE "FriendGroupMember" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "FriendGroup" ADD COLUMN IF NOT EXISTS "about" TEXT;

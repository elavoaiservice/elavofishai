-- Who can find an angler by searching. Existing accounts get the middle
-- setting: findable by friends of friends, not by the whole platform.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "discoverability" TEXT NOT NULL DEFAULT 'friends_of_friends';

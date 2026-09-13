-- Not every admin needs the delete button. Existing admins keep everything
-- they had, so nobody is locked out by this.
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'owner';
-- The audit log is searched by action and by who it was done to, and never swept.
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_target_idx" ON "AuditLog"("target");

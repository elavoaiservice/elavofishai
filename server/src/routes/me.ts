import type { FastifyInstance } from 'fastify';
import { currentUser } from '../lib/auth';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Never errors for anonymous users. `user` stays a string (or null) for
  // backward-compat with the existing frontend; `account` carries the full record.
  app.get('/api/me', async (req) => {
    const u = await currentUser(req);
    return {
      user: u ? (u.displayName || u.username || u.email) : null,
      inviteRequired: false,
      account: u
        ? { id: u.id, email: u.email, displayName: u.displayName, username: u.username, role: u.role }
        : null,
    };
  });
}

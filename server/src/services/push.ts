/**
 * Push notifications.
 *
 * The bell inside the app only works while the app is open, which is almost
 * never — someone is told a friend commented on their catch when they next
 * happen to open the page, by which time it is stale news. A push reaches the
 * phone in the pocket, which is the whole point of a notification.
 *
 * Two rules shape everything here:
 *  - permission is asked for at a moment that explains itself, never on load,
 *    and the browser only gives one chance at it (see the client side)
 *  - a push says as little as possible. The notification is a nudge to open
 *    the app, not a copy of the content — a lock screen is a public place.
 */
import webpush from 'web-push';
import { prisma } from '../db';
import type { NotifyType } from './notify';

let configured: boolean | null = null;

/** VAPID is how a push service knows the message really came from us. */
export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@elavoai.com';
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } catch {
    configured = false;
  }
  return configured;
}

/** The public half, which the browser needs to subscribe. */
export function publicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || '';
}

/** Generate a key pair for an operator to paste into the config. */
export function generateKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it should land. */
  url: string;
  /** Collapses older pushes of the same kind rather than stacking them. */
  tag?: string;
}

/**
 * What a notification says on a lock screen.
 *
 * Deliberately vague about content: "Dave commented on your catch" rather than
 * the comment itself. Someone's phone screen is visible to whoever is near it,
 * and none of this is worth leaking to a stranger on a bus.
 */
export function messageFor(type: NotifyType | string, actorName: string | null, groupName: string | null): PushMessage | null {
  const who = actorName || 'Someone';
  switch (type) {
    case 'comment':
      return { title: 'New comment', body: `${who} commented on your post`, url: '/app#feed', tag: 'comment' };
    case 'like':
      return { title: 'Someone liked your post', body: `${who} liked your post`, url: '/app#feed', tag: 'like' };
    case 'friend_request':
      return { title: 'Friend request', body: `${who} wants to join your crew`, url: '/app#friends', tag: 'friends' };
    case 'friend_accepted':
      return { title: 'Request accepted', body: `${who} is now in your crew`, url: '/app#friends', tag: 'friends' };
    case 'group_invite':
      return { title: 'Group invitation', body: `${who} invited you to ${groupName || 'a group'}`, url: '/app#friends', tag: 'groups' };
    case 'group_post':
      return { title: groupName || 'Your group', body: `${who} posted in ${groupName || 'your group'}`, url: '/app#feed', tag: `group` };
    case 'tournament_invite':
      return { title: 'Tournament', body: `${who} invited you to a tournament`, url: '/app#friends', tag: 'tournament' };
    case 'tournament_changed':
      return { title: 'Tournament changed', body: `${who} changed a tournament you entered`, url: '/app#friends', tag: 'tournament' };
    case 'invite_accepted':
      return { title: 'They joined', body: `${who} joined ElavoFishAI from your invite`, url: '/app#friends', tag: 'friends' };
    // Everything else is not worth a buzz in someone's pocket.
    default:
      return null;
  }
}

/**
 * Send to every browser this angler has registered. A subscription the push
 * service rejects as gone (404/410) is deleted — keeping it would mean failing
 * forever on a phone that has been wiped.
 */
export async function sendToUser(userId: string, msg: PushMessage): Promise<number> {
  if (!pushConfigured()) return 0;
  const subs = await prisma.pushSubscription.findMany({ where: { userId, failedAt: null } });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg),
        { TTL: 12 * 3600 }
      );
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      } else {
        // A transient failure is not a dead device; mark it and move on so one
        // bad endpoint cannot hold up the rest.
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { failedAt: new Date() } }).catch(() => {});
      }
    }
  }
  return sent;
}

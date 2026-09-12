// Central config. Everything the server needs, read once from the environment.
function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

const NODE_ENV = process.env.NODE_ENV || 'development';

export const env = {
  nodeEnv: NODE_ENV,
  isProd: NODE_ENV === 'production',
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || '0.0.0.0',

  databaseUrl: process.env.DATABASE_URL || '',

  // Public origin the app is reached at (magic-link URLs, cookie Secure flag).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // Cookies are Secure only when we know we're behind HTTPS.
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  cookieName: process.env.COOKIE_NAME || 'efa_session',
  // 400 days is the longest a browser will honour a cookie (RFC 6265bis), and
  // the session slides forward on use — see lib/auth.ts. Effect: signed in
  // until you sign out.
  sessionDays: Number(process.env.SESSION_DAYS || 400),
  magicLinkTtlMin: Number(process.env.MAGIC_LINK_TTL_MIN || 15),

  // Dev/console magic-link mode: return + log the link instead of emailing it.
  // Handing the caller a sign-in link for any address they type is a full
  // account takeover, so in production this needs an explicit opt-in (below)
  // and the link is only ever returned to a caller on the local network.
  devShowMagicLink: bool(process.env.DEV_SHOW_MAGIC_LINK, NODE_ENV !== 'production'),

  // Explicit "yes, I know" for running a production build with dev links on —
  // for a LAN prototype with no email provider yet.
  allowInsecureDevLogin: bool(process.env.ALLOW_INSECURE_DEV_LOGIN, false),

  // AI lake profiles (P1). Absent key → profiles stay pending, engine still works.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiProfileModel: process.env.AI_PROFILE_MODEL || 'claude-opus-4-8',

  // Per-user KV caps (mirror the original server's guardrails).
  maxKeyBytes: 2 * 1024 * 1024,
  maxKeysPerUser: 128,
  maxUserBytes: 16 * 1024 * 1024,
};

export function requireEnv(): void {
  // A magic link is a credential, and without this the address inside it would
  // be built from a request header the caller controls — "Host: evil.example"
  // and the user is emailed a working token pointing somewhere else.
  if (env.isProd && !env.publicBaseUrl) {
    throw new Error(
      'Refusing to start: PUBLIC_BASE_URL is required in production. Sign-in links ' +
        'are built from it, and falling back to the Host header lets a caller choose ' +
        'where a user\'s token gets sent. Set PUBLIC_BASE_URL=https://your.domain'
    );
  }
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  // Refuse to start a production server that hands out sign-in links: anyone who
  // can reach it could request a link for any email and become that user.
  if (env.isProd && env.devShowMagicLink && !env.allowInsecureDevLogin) {
    throw new Error(
      'Refusing to start: DEV_SHOW_MAGIC_LINK is on in production, which lets any ' +
        'caller sign in as any email. Set DEV_SHOW_MAGIC_LINK=0 and configure ' +
        'RESEND_API_KEY + EMAIL_FROM to email real links, or set ' +
        'ALLOW_INSECURE_DEV_LOGIN=1 to accept the risk on a trusted LAN ' +
        '(links are still only returned to private-network clients).'
    );
  }
}

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
  sessionDays: Number(process.env.SESSION_DAYS || 90),
  magicLinkTtlMin: Number(process.env.MAGIC_LINK_TTL_MIN || 15),

  // Dev/console magic-link mode: return + log the link instead of emailing it.
  // (Real email provider gets wired in P3.)
  devShowMagicLink: bool(process.env.DEV_SHOW_MAGIC_LINK, NODE_ENV !== 'production'),

  // AI lake profiles (P1). Absent key → profiles stay pending, engine still works.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiProfileModel: process.env.AI_PROFILE_MODEL || 'claude-opus-4-8',

  // Per-user KV caps (mirror the original server's guardrails).
  maxKeyBytes: 2 * 1024 * 1024,
  maxKeysPerUser: 128,
  maxUserBytes: 16 * 1024 * 1024,
};

export function requireEnv(): void {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
}

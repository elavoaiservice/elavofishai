import crypto from 'crypto';

// Opaque, URL-safe random token (for magic links + sessions).
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

// We store only the hash of any bearer token, never the token itself.
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

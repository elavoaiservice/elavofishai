import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './db';

// Runtime settings managed from the admin Settings GUI. Values are stored in the
// AppConfig table (secrets encrypted at rest) and overlaid onto process.env so the
// app picks them up live — no restart, no redeploy.

export interface ConfigItem {
  key: string;
  label: string;
  group: string;
  secret?: boolean;
  test?: boolean;
  placeholder?: string;
  help?: string;
  choices?: string[]; // when set, the admin GUI renders a dropdown
}

// Who may send a new user a direct message, by default. Admin-configurable.
export // Model menus. Price per million tokens is in the label so the choice is made
// with the cost visible, not looked up afterwards.
const MODEL_CHOICES = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
];
const FALLBACK_CHOICES = ['', ...MODEL_CHOICES];
// Vision: the models that can actually read an image.
const VISION_CHOICES = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'gpt-5', 'gpt-4o', 'gpt-4o-mini'];
const VISION_FALLBACK_CHOICES = ['', ...VISION_CHOICES];

export const MESSAGE_PRIVACY_CHOICES = ['everyone', 'friends', 'nobody'];
export function defaultMessagePrivacy(): string {
  const v = (process.env.DEFAULT_MESSAGE_PRIVACY || '').toLowerCase();
  return MESSAGE_PRIVACY_CHOICES.includes(v) ? v : 'friends';
}

export const CATALOG: ConfigItem[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'AI', secret: true, test: true, placeholder: 'sk-ant-...', help: 'Powers AI lake guides + the day planner.' },
  { key: 'AI_PROFILE_MODEL', label: 'Lake guide — model', group: 'AI', choices: MODEL_CHOICES, placeholder: 'claude-opus-4-8', help: 'Written once per lake and cached forever, so quality matters more than price here.' },
  { key: 'AI_PROFILE_FALLBACK', label: 'Lake guide — fallback', group: 'AI', choices: FALLBACK_CHOICES, placeholder: '', help: 'Used only when the first model errors or returns something unusable.' },
  { key: 'AI_PLAN_MODEL', label: 'Day plan — model', group: 'AI', choices: MODEL_CHOICES, placeholder: 'claude-sonnet-5', help: 'Generated while an angler waits — favour a fast one.' },
  { key: 'AI_PLAN_FALLBACK', label: 'Day plan — fallback', group: 'AI', choices: FALLBACK_CHOICES, placeholder: '', help: 'Try a cheap model first and fall back to a stronger one here.' },
  { key: 'AI_VISION_MODEL', label: 'Catch photos — model', group: 'AI', choices: VISION_CHOICES, placeholder: 'claude-opus-4-8', help: 'Reads a photo of a fish. Must be a vision-capable model.' },
  { key: 'AI_VISION_FALLBACK', label: 'Catch photos — fallback', group: 'AI', choices: VISION_FALLBACK_CHOICES, placeholder: '' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'AI', secret: true, test: true, placeholder: 'sk-...', help: 'Only needed if you pick a gpt-* model above.' },
  { key: 'AI_WEB_SEARCH', label: 'Web search in day plans', group: 'AI', choices: ['0', '1'], placeholder: '0', help: 'Let the planner search for recent fishing reports. Billed $10 per 1,000 searches on top of tokens (max 4 per plan).' },
  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'Email', secret: true, test: true, placeholder: 're_...', help: 'Sends magic-link + admin MFA emails (replaces dev/console mode).' },
  { key: 'EMAIL_FROM', label: 'From address', group: 'Email', placeholder: 'ElavoFishAI <hello@elavoai.com>' },
  { key: 'PUBLIC_BASE_URL', label: 'Public base URL', group: 'App', test: true, placeholder: 'https://elavofishai.elavoai.com' },
  // ---- object storage (Cloudflare R2 or any S3-compatible service) ----
  { key: 'HEARTBEAT_URL', label: 'Heartbeat ping URL', group: 'Notifications', placeholder: 'https://hc-ping.com/…', help: 'The app pings this every 5 minutes. Point it at a dead-man\'s-switch service (healthchecks.io, Better Stack) and it will alert you when the pings stop — the only way to find out the whole machine has gone, since a watchdog on the machine cannot report its own death.' },
  { key: 'VAPID_PUBLIC_KEY', label: 'Push public key', group: 'Notifications', placeholder: 'B…', help: 'Web-push VAPID keys. Generate a pair with: npx web-push generate-vapid-keys — paste the public half here and the private half below. Without them the app falls back to in-app notifications only.' },
  { key: 'VAPID_PRIVATE_KEY', label: 'Push private key', group: 'Notifications', secret: true, placeholder: '…' },
  { key: 'VAPID_SUBJECT', label: 'Push contact', group: 'Notifications', placeholder: 'mailto:support@elavoai.com', help: 'Where a push service should complain if something is wrong. An email address or a URL.' },
  { key: 'R2_ACCOUNT_ID', label: 'R2 account ID', group: 'Storage', placeholder: 'a1b2c3…', help: 'From the Cloudflare dashboard. The endpoint is built from this; or set S3_ENDPOINT for a non-R2 service.' },
  { key: 'R2_BUCKET', label: 'Bucket name', group: 'Storage', placeholder: 'elavofishai', help: 'Keep it PRIVATE — photos are served through the app so sharing rules are enforced.' },
  { key: 'R2_ACCESS_KEY_ID', label: 'Access key ID', group: 'Storage', secret: true, placeholder: '…' },
  { key: 'R2_SECRET_ACCESS_KEY', label: 'Secret access key', group: 'Storage', secret: true, test: true, placeholder: '…', help: 'Test writes, reads back and deletes a small object.' },
  { key: 'S3_ENDPOINT', label: 'Custom endpoint', group: 'Storage', placeholder: '(optional — for S3, B2, MinIO…)' },
  { key: 'BACKUP_TO_STORAGE', label: 'Copy backups to storage', group: 'Storage', choices: ['0', '1'], placeholder: '1', help: 'Nightly dumps are uploaded to the bucket. Without this they only exist on the Mini — the machine they are backing up.' },

  { key: 'DEFAULT_MESSAGE_PRIVACY', label: 'Default message privacy', group: 'Social', choices: MESSAGE_PRIVACY_CHOICES, placeholder: 'friends', help: 'Who can DM a NEW user by default: everyone, friends (recommended), or nobody. Each user can change their own setting in the app.' },
];

const ENC_PREFIX = 'enc:';
function encKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || 'elavofishai-insecure-default-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(s: string): string {
  if (!s.startsWith(ENC_PREFIX)) return s;
  try {
    const buf = Buffer.from(s.slice(ENC_PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const isSecret = (key: string) => !!CATALOG.find((c) => c.key === key)?.secret;

// Overlay all stored config onto process.env (called on boot + after every save).
export async function loadOverlay(): Promise<void> {
  const rows = await prisma.appConfig.findMany();
  for (const r of rows) {
    const val = r.encrypted ? decrypt(r.value) : r.value;
    if (val) process.env[r.key] = val;
  }
}

export async function setValue(key: string, value: string): Promise<void> {
  const item = CATALOG.find((c) => c.key === key);
  if (!item) throw new Error('unknown setting');
  if (item.choices && value && !item.choices.includes(value)) {
    throw new Error(`must be one of: ${item.choices.join(', ')}`);
  }
  const secret = isSecret(key);
  const stored = secret ? encrypt(value) : value;
  await prisma.appConfig.upsert({
    where: { key },
    create: { key, value: stored, encrypted: secret },
    update: { value: stored, encrypted: secret },
  });
  if (value) process.env[key] = value;
  else delete process.env[key];
}

export async function currentValue(key: string): Promise<string> {
  const row = await prisma.appConfig.findUnique({ where: { key } });
  if (row) return row.encrypted ? decrypt(row.value) : row.value;
  return process.env[key] || '';
}

// Masked view for the UI: secrets never leave the server in the clear.
export async function maskedView() {
  const rows = await prisma.appConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return CATALOG.map((c) => {
    const stored = byKey.get(c.key);
    const raw = stored ? (stored.encrypted ? decrypt(stored.value) : stored.value) : process.env[c.key] || '';
    const set = !!raw;
    return {
      ...c,
      set,
      value: c.secret ? (set ? '••••••••' : '') : raw,
    };
  });
}

export interface TestResult { ok: boolean; message: string }

export async function testValue(key: string, value: string): Promise<TestResult> {
  const v = value && value !== '••••••••' ? value : await currentValue(key);
  if (!v) return { ok: false, message: 'No value to test.' };
  try {
    if (key === 'ANTHROPIC_API_KEY') {
      const client = new Anthropic({ apiKey: v });
      await client.messages.create({ model: process.env.AI_PROFILE_MODEL || 'claude-opus-4-8', max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] } as Anthropic.MessageCreateParamsNonStreaming);
      return { ok: true, message: 'Anthropic key works.' };
    }
    if (key === 'R2_SECRET_ACCESS_KEY') {
      // Prove the whole path, not just the key: write, read back, delete.
      const { testStorage } = await import('./services/storage');
      return testStorage();
    }
    if (key === 'OPENAI_API_KEY') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${v}` },
        signal: AbortSignal.timeout(8000),
      });
      return r.ok ? { ok: true, message: 'OpenAI key works.' } : { ok: false, message: `OpenAI returned ${r.status}.` };
    }
    if (key === 'RESEND_API_KEY') {
      const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(8000) });
      return r.ok ? { ok: true, message: 'Resend key works.' } : { ok: false, message: `Resend returned ${r.status}.` };
    }
    if (key === 'PUBLIC_BASE_URL') {
      const u = new URL(v);
      return { ok: u.protocol.startsWith('http'), message: u.protocol.startsWith('http') ? 'Valid URL.' : 'Must be http(s).' };
    }
    return { ok: true, message: 'No test for this setting.' };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 140) || 'Test failed.' };
  }
}

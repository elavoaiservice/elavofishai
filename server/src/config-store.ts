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
export const MESSAGE_PRIVACY_CHOICES = ['everyone', 'friends', 'nobody'];
export function defaultMessagePrivacy(): string {
  const v = (process.env.DEFAULT_MESSAGE_PRIVACY || '').toLowerCase();
  return MESSAGE_PRIVACY_CHOICES.includes(v) ? v : 'friends';
}

export const CATALOG: ConfigItem[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'AI', secret: true, test: true, placeholder: 'sk-ant-...', help: 'Powers AI lake guides + the day planner.' },
  { key: 'AI_PROFILE_MODEL', label: 'AI model', group: 'AI', placeholder: 'claude-opus-4-8', help: 'claude-opus-4-8 (best) or claude-sonnet-5 (cheaper).' },
  { key: 'AI_PLAN_MODEL', label: 'Day-plan model', group: 'AI', placeholder: 'claude-sonnet-5', help: 'Day plans are generated while someone waits — the fast model by default.' },
  { key: 'AI_WEB_SEARCH', label: 'Web search in day plans', group: 'AI', choices: ['0', '1'], placeholder: '0', help: 'Let the planner search for recent fishing reports. Billed $10 per 1,000 searches on top of tokens (max 4 per plan).' },
  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'Email', secret: true, test: true, placeholder: 're_...', help: 'Sends magic-link + admin MFA emails (replaces dev/console mode).' },
  { key: 'EMAIL_FROM', label: 'From address', group: 'Email', placeholder: 'ElavoFishAI <hello@elavoai.com>' },
  { key: 'PUBLIC_BASE_URL', label: 'Public base URL', group: 'App', test: true, placeholder: 'https://elavofishai.elavoai.com' },
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

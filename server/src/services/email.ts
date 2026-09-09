// Transactional email via Resend. Reads RESEND_API_KEY / EMAIL_FROM from the
// environment at call time, so a key pasted into the admin Settings takes effect
// live. When no key is set, callers fall back to dev/console mode.

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

// Last delivery outcome, kept in memory so the admin panel can show whether
// sign-in email is actually working. A send that fails used to be logged and
// forgotten, which is how "check your email" can lie to every new user.
export interface EmailStatus {
  configured: boolean;
  from: string;
  fromIsDefault: boolean;
  lastSentAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  sent: number;
  failed: number;
}
const DEFAULT_FROM = 'ElavoFishAI <onboarding@resend.dev>';
let lastSentAt: string | null = null;
let lastErrorAt: string | null = null;
let lastError: string | null = null;
let sent = 0;
let failed = 0;

export function emailStatus(): EmailStatus {
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  return {
    configured: emailConfigured(),
    from,
    // Resend's shared onboarding sender only delivers to the account owner's
    // own address — every other recipient silently gets nothing.
    fromIsDefault: !process.env.EMAIL_FROM,
    lastSentAt,
    lastErrorAt,
    lastError,
    sent,
    failed,
  };
}

function noteSent(): void {
  sent++;
  lastSentAt = new Date().toISOString();
}
function noteFailed(message: string): void {
  failed++;
  lastErrorAt = new Date().toISOString();
  lastError = message.slice(0, 300);
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    noteFailed('No RESEND_API_KEY configured.');
    return false;
  }
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      // eslint-disable-next-line no-console
      console.error(`[email] Resend ${res.status}: ${detail}`);
      noteFailed(`Resend ${res.status}: ${detail}`);
      return false;
    }
    noteSent();
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[email] send failed', e);
    noteFailed((e as Error).message || 'send failed');
    return false;
  }
}

const WRAP = (inner: string) => `<!doctype html><html><body style="margin:0;background:#f8fbff;font-family:Inter,Segoe UI,system-ui,sans-serif;color:#10233f;padding:28px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #dce7f5;border-radius:16px;padding:28px">
    <div style="font-weight:800;font-size:20px;margin-bottom:16px">Elavo<span style="color:#29ABE2">Fish</span>AI</div>
    ${inner}
    <div style="margin-top:24px;border-top:1px solid #eef4fc;padding-top:14px;color:#5f708a;font-size:12px">ElavoFishAI · the private fishing network</div>
  </div></body></html>`;

export function magicLinkEmail(url: string, purpose: 'login' | 'signup'): { subject: string; html: string } {
  const verb = purpose === 'signup' ? 'Finish creating your account' : 'Sign in';
  return {
    subject: purpose === 'signup' ? 'Finish creating your ElavoFishAI account' : 'Your ElavoFishAI sign-in link',
    html: WRAP(
      `<p style="font-size:15px;margin:0 0 18px">${verb} — this link is good for 15 minutes:</p>
       <p style="margin:0 0 22px"><a href="${url}" style="display:inline-block;background:#29ABE2;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px">${verb}</a></p>
       <p style="color:#5f708a;font-size:13px;margin:0">If you didn't request this, you can ignore this email.</p>`
    ),
  };
}

export function adminMfaEmail(code: string): { subject: string; html: string } {
  return {
    subject: 'Your ElavoFishAI admin sign-in code',
    html: WRAP(
      `<p style="font-size:15px;margin:0 0 12px">Your admin verification code:</p>
       <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#1F96C8;margin:0 0 18px">${code}</p>
       <p style="color:#5f708a;font-size:13px;margin:0">Expires in 10 minutes. If this wasn't you, change your admin password.</p>`
    ),
  };
}

// Transactional email via Resend. Reads RESEND_API_KEY / EMAIL_FROM from the
// environment at call time, so a key pasted into the admin Settings takes effect
// live. When no key is set, callers fall back to dev/console mode.

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.EMAIL_FROM || 'ElavoFishAI <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[email] Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[email] send failed', e);
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

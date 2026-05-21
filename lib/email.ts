// Minimal transactional email helper.
// Currently wraps Resend (https://resend.com), chosen because it has a generous
// free tier and a zero-dep HTTP API. If RESEND_API_KEY is unset, sendEmail()
// returns { sent: false, reason: 'unconfigured' } so callers can fall back
// to copy-paste UX without crashing.

export type SendEmailArgs = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
};

export type SendEmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: 'unconfigured' | 'failed'; error?: string };

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'unconfigured' };

  // `onboarding@resend.dev` works without verifying a domain — handy for dev.
  // Set EMAIL_FROM once you've verified a domain in Resend.
  const from = args.from ?? process.env.EMAIL_FROM ?? 'Mid-South WX <onboarding@resend.dev>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
        reply_to: args.replyTo,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        sent: false,
        reason: 'failed',
        error: `Resend ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { id?: string };
    return { sent: true, id: data.id ?? 'unknown' };
  } catch (e) {
    return {
      sent: false,
      reason: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

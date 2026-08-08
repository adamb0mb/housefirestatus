// Sends transactional email via Resend (resend.com). Requires two things the app
// can't provision on its own — a Resend account with an API key (RESEND_API_KEY
// secret) and a verified sending domain (NOTIFICATION_FROM_EMAIL, e.g.
// "alerts@phillabaum.us") — see README for setup. If either is missing, calls here
// are no-ops that log instead of throwing, so the rest of the app (and the cron
// job's other subscribers) keeps working even before email is configured.

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM_EMAIL) {
    console.log(`[email disabled — no RESEND_API_KEY/NOTIFICATION_FROM_EMAIL configured] would send to ${to}: ${subject}`);
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.NOTIFICATION_FROM_EMAIL,
        to: [to],
        subject,
        html
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.log(`[email send failed] ${resp.status} ${detail.slice(0, 300)}`);
      return { ok: false, status: resp.status };
    }
    return { ok: true };
  } catch (err) {
    console.log(`[email send error] ${err}`);
    return { ok: false, error: String(err) };
  }
}

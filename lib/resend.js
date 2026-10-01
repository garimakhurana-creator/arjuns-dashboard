// Minimal Resend client: POST https://api.resend.com/emails.
//
// Test mode: when EMAIL_OVERRIDE_TO is set, every email is delivered there
// instead of to the candidate, with a note saying who it was meant for. The
// candidate's own address stays on their record untouched.

const overrideTo = () => (process.env.EMAIL_OVERRIDE_TO || '').trim();

async function sendEmail({ to, subject, text, scheduledAt }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set. Add it to kargo-hiring/.env.');
  if (!to) throw new Error('Candidate has no email address on file.');

  const testTo = overrideTo();
  const body = {
    from: process.env.RESEND_FROM || 'Arjun at Kargo <onboarding@resend.dev>',
    to: [testTo || to],
    subject,
    text: testTo ? `[Test mode: this email would have gone to ${to}]\n\n${text}` : text,
  };
  if (process.env.RESEND_REPLY_TO) body.reply_to = process.env.RESEND_REPLY_TO;
  if (scheduledAt) body.scheduled_at = scheduledAt;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message || JSON.stringify(data)}`);
  return { ...data, delivered_to: testTo || to, intended_for: to }; // { id, ... }
}

module.exports = { sendEmail, overrideTo };

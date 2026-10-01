const store = require('./store');
const { sendEmail } = require('./resend');

const rejectionDelayHours = () => Number(process.env.REJECTION_DELAY_HOURS || 48);

// Sends the candidate's current draft through Resend and records the outcome.
// Invites go out now; rejections are scheduled REJECTION_DELAY_HOURS ahead so
// they don't feel automated. Throws on failure after logging it.
async function deliverEmail(candidateId) {
  const rec = await store.get(candidateId);
  const draft = rec.deliverables.resend_email_draft;
  const isInvite = draft.type === 'INTERVIEW_INVITE';
  const scheduledAt = isInvite ? null : new Date(Date.now() + rejectionDelayHours() * 3600 * 1000).toISOString();
  try {
    const result = await sendEmail({ to: draft.recipient_email, subject: draft.subject, text: draft.body_text, scheduledAt });
    await store.update(candidateId, r => {
      if (isInvite) r.status = 'INVITED';
      r.email_status = isInvite ? 'SENT' : 'SCHEDULED';
      r.email_history.push({ type: draft.type, resend_id: result.id, delivered_to: result.delivered_to, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}), at: new Date().toISOString() });
    });
    return { resend_id: result.id, scheduled_at: scheduledAt };
  } catch (err) {
    await store.update(candidateId, r => {
      r.email_history.push({ type: draft.type, error: err.message, at: new Date().toISOString() });
    });
    throw err;
  }
}

module.exports = { deliverEmail, rejectionDelayHours };

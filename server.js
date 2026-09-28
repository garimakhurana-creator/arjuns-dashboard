const express = require('express');
const multer = require('multer');
const path = require('path');

require('./lib/env').loadDotEnv();

const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const store = require('./lib/store');
const { evaluateCv } = require('./lib/pipeline');
const { sendEmail } = require('./lib/resend');
const llm = require('./lib/llm');

const app = express();
const PORT = process.env.PORT || 3500;
const REJECTION_DELAY_HOURS = Number(process.env.REJECTION_DELAY_HOURS || 48);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 30 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function fileToText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    return (await pdfParse(file.buffer)).text;
  }
  if (/\.(txt|md|text)$/.test(name) || file.mimetype.startsWith('text/')) {
    return file.buffer.toString('utf-8');
  }
  throw new Error(`Unsupported file type for ${file.originalname}. Upload PDF or plain text.`);
}

// Full card for the shortlist tab (High potential only).
function dashboardView(r) {
  return {
    candidate_id: r.candidate_id,
    candidate_name: r.candidate_name,
    selected_role: r.selected_role,
    evaluation_timestamp: r.evaluation_timestamp,
    scoring: r.scoring,
    risk_assessment: r.risk_assessment,
    categorization: r.categorization,
    deliverables: {
      interview_brief: r.deliverables.interview_brief,
      resend_email_draft: r.deliverables.resend_email_draft,
    },
    status: r.status,
    email_status: r.email_status,
    email_history: r.email_history,
  };
}

// One-line row for the review queue: enough to decide, no full brief.
function conciseView(r) {
  const last = r.email_history[r.email_history.length - 1] || null;
  return {
    candidate_id: r.candidate_id,
    candidate_name: r.candidate_name,
    selected_role: r.selected_role,
    category: r.categorization.category,
    match_score_pct: r.scoring.match_score_pct,
    total_risk_score: r.scoring.total_risk_score,
    risk_flags: r.risk_assessment.active_risk_flags.map(f => f.flag),
    reason: r.categorization.recommendation_reason,
    closest_historical_match: r.categorization.closest_historical_match,
    status: r.status,
    email_status: r.email_status,
    email: r.deliverables.resend_email_draft,
    last_email_event: last,
  };
}

const byScore = (a, b) =>
  b.scoring.match_score_pct - a.scoring.match_score_pct ||
  a.scoring.total_risk_score - b.scoring.total_risk_score;
const isRejection = r => r.deliverables.resend_email_draft.type === 'DELAYED_REJECTION';

app.get('/api/config', (req, res) => {
  res.json({
    llm_configured: llm.isConfigured(),
    llm_provider: llm.provider(),
    resend_configured: Boolean(process.env.RESEND_API_KEY),
    calendly_url: process.env.CALENDLY_URL || null,
    rejection_delay_hours: REJECTION_DELAY_HOURS,
    model: llm.activeModel(),
    storage: store.backendName(),
  });
});

app.post('/api/candidates', upload.array('cv'), async (req, res) => {
  const role = String(req.body.role || '').toUpperCase();
  if (!['PM', 'SPM'].includes(role)) return res.status(400).json({ error: 'Select a role: PM or SPM.' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Attach at least one CV.' });

  // Name/email overrides only make sense for a single upload.
  const overrides = req.files.length === 1 ? { name: req.body.name, email: req.body.email } : {};
  const results = [];

  for (const file of req.files) {
    try {
      const rawText = await fileToText(file);
      const record = await evaluateCv({
        rawText,
        roleCode: role,
        overrides,
        candidateId: await store.nextCandidateId(),
        calendlyUrl: process.env.CALENDLY_URL,
      });
      record.source_file = file.originalname;
      await store.insert(record);
      const surfaced = record.categorization.surfaced_to_arjun_dashboard;

      // Low potential: no founder approval needed. The rejection is scheduled
      // immediately; if Resend fails it stays queued for a retry.
      let rejection_email;
      if (!surfaced) {
        try {
          rejection_email = { scheduled: true, ...(await deliverEmail(record.candidate_id)) };
        } catch (err) {
          rejection_email = { scheduled: false, error: err.message };
        }
      }

      results.push({
        file: file.originalname,
        candidate_id: record.candidate_id,
        category: record.categorization.category,
        surfaced,
        rejection_email,
        // Low-potential outcomes are acknowledged but not detailed on the dashboard.
        candidate_name: surfaced ? record.candidate_name : undefined,
      });
    } catch (err) {
      console.error(`Evaluation failed for ${file.originalname}:`, err);
      results.push({ file: file.originalname, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/dashboard', async (req, res) => {
  const all = await store.readAll();
  const high = all
    .filter(r => r.categorization.category === 'HIGH_POTENTIAL' && r.status !== 'PASSED_BY_FOUNDER')
    .sort(byScore)
    .map(dashboardView);

  res.json({
    candidates: high,
    stats: {
      total_evaluated: all.length,
      high: all.filter(r => r.categorization.category === 'HIGH_POTENTIAL').length,
      medium: all.filter(r => r.categorization.category === 'MEDIUM_POTENTIAL').length,
      auto_rejected: all.filter(r => r.categorization.category === 'LOW_POTENTIAL').length,
      medium_awaiting: all.filter(r => r.categorization.category === 'MEDIUM_POTENTIAL' && r.status === 'AWAITING_FOUNDER').length,
      rejections_queued: all.filter(r => r.email_status === 'QUEUED').length,
      invites_sent: all.filter(r => r.status === 'INVITED').length,
    },
  });
});

// Review queue: Medium candidates still in play, plus every rejection email
// (Low auto-rejects and candidates Arjun passed on), as concise rows.
app.get('/api/review', async (req, res) => {
  const all = await store.readAll();
  res.json({
    medium: all
      .filter(r => r.categorization.category === 'MEDIUM_POTENTIAL' && !isRejection(r))
      .sort(byScore)
      .map(conciseView),
    rejections: all
      .filter(isRejection)
      .sort((a, b) => (a.email_status === 'QUEUED' ? 0 : 1) - (b.email_status === 'QUEUED' ? 0 : 1) || byScore(a, b))
      .map(conciseView),
    rejection_delay_hours: REJECTION_DELAY_HOURS,
  });
});

// Full audit log: every candidate, including auto-rejected ones.
app.get('/api/audit', async (req, res) => {
  res.json({ records: (await store.readAll()).reverse() });
});

app.patch('/api/candidates/:id/email', async (req, res) => {
  const { subject, body_text, recipient_email } = req.body || {};
  const rec = await store.update(req.params.id, r => {
    const d = r.deliverables.resend_email_draft;
    if (typeof subject === 'string') d.subject = subject;
    if (typeof body_text === 'string') d.body_text = body_text;
    if (typeof recipient_email === 'string') d.recipient_email = recipient_email.trim();
  });
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ ok: true });
});

// Sends the candidate's current draft through Resend and records the outcome.
// Invites go out now; rejections are scheduled REJECTION_DELAY_HOURS ahead so
// they don't feel automated. Throws on failure after logging it.
async function deliverEmail(candidateId) {
  const rec = await store.get(candidateId);
  const draft = rec.deliverables.resend_email_draft;
  const isInvite = draft.type === 'INTERVIEW_INVITE';
  const scheduledAt = isInvite ? null : new Date(Date.now() + REJECTION_DELAY_HOURS * 3600 * 1000).toISOString();
  try {
    const result = await sendEmail({ to: draft.recipient_email, subject: draft.subject, text: draft.body_text, scheduledAt });
    await store.update(candidateId, r => {
      if (isInvite) r.status = 'INVITED';
      r.email_status = isInvite ? 'SENT' : 'SCHEDULED';
      r.email_history.push({ type: draft.type, resend_id: result.id, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}), at: new Date().toISOString() });
    });
    return { resend_id: result.id, scheduled_at: scheduledAt };
  } catch (err) {
    await store.update(candidateId, r => {
      r.email_history.push({ type: draft.type, error: err.message, at: new Date().toISOString() });
    });
    throw err;
  }
}

app.post('/api/candidates/:id/send', async (req, res) => {
  const rec = await store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  if (['SENT', 'SCHEDULED'].includes(rec.email_status)) return res.status(409).json({ error: 'Email already sent.' });
  try {
    res.json({ ok: true, ...(await deliverEmail(rec.candidate_id)) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Arjun decides not to proceed with a surfaced candidate: swap in the
// pre-written rejection and add it to the delayed-rejection queue.
app.post('/api/candidates/:id/pass', async (req, res) => {
  const rec = await store.update(req.params.id, r => {
    if (['SENT', 'SCHEDULED'].includes(r.email_status)) return;
    r.status = 'PASSED_BY_FOUNDER';
    r.founder_decision = { decision: 'PASS', note: (req.body && req.body.note) || '', at: new Date().toISOString() };
    if (r.deliverables.fallback_rejection_draft) {
      r.deliverables.resend_email_draft = r.deliverables.fallback_rejection_draft;
    }
    r.email_status = 'QUEUED';
  });
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  if (rec.status !== 'PASSED_BY_FOUNDER') return res.status(409).json({ error: 'Invite already sent; cannot pass.' });
  res.json({ ok: true });
});

// One click: schedule every queued rejection via Resend, delivered after the delay.
app.post('/api/rejections/send-batch', async (req, res) => {
  const queued = (await store.readAll()).filter(r => r.email_status === 'QUEUED');
  const scheduledAt = new Date(Date.now() + REJECTION_DELAY_HOURS * 3600 * 1000).toISOString();
  let scheduled = 0;
  const failures = [];

  for (const r of queued) {
    const d = r.deliverables.resend_email_draft;
    try {
      const result = await sendEmail({ to: d.recipient_email, subject: d.subject, text: d.body_text, scheduledAt });
      await store.update(r.candidate_id, x => {
        x.email_status = 'SCHEDULED';
        x.email_history.push({ type: d.type, resend_id: result.id, scheduled_at: scheduledAt, at: new Date().toISOString() });
      });
      scheduled++;
    } catch (err) {
      failures.push({ candidate_id: r.candidate_id, error: err.message });
      if (/RESEND_API_KEY/.test(err.message)) break;
    }
  }
  res.status(failures.length && !scheduled ? 502 : 200).json({ scheduled, scheduled_at: scheduledAt, failures });
});

app.listen(PORT, () => {
  console.log(`Kargo hiring dashboard running at http://localhost:${PORT} (storage: ${store.backendName()}, LLM: ${llm.provider()})`);
});

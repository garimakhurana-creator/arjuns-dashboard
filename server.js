const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

require('./lib/env').loadDotEnv();

const { pdfToText } = require('./lib/pdf');
const { docxToText } = require('./lib/docx');
const store = require('./lib/store');
const { evaluateCv } = require('./lib/pipeline');
const { sendEmail, overrideTo } = require('./lib/resend');
const { deliverEmail } = require('./lib/dispatch');
const llm = require('./lib/llm');
const { requirePassword } = require('./lib/auth');
const { RUBRIC_VERSION } = require('./lib/rubric');

const app = express();
const PORT = process.env.PORT || 3500;
const REJECTION_DELAY_HOURS = Number(process.env.REJECTION_DELAY_HOURS || 48);
const ON_VERCEL = Boolean(process.env.VERCEL);
// Each CV takes ~80s to evaluate and a Vercel request is capped at 300s, so
// uploads there are limited; use scripts/evaluate-folder.js for bulk imports.
const MAX_FILES = ON_VERCEL ? 3 : 30;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: MAX_FILES } });

// Password is optional locally, mandatory on a deployment.
app.use(requirePassword({ required: ON_VERCEL }));
// Vercel's filesystem is read-only, so the local JSON store can't work there.
app.use('/api', (req, res, next) => {
  if (ON_VERCEL && store.backendName() !== 'neon') {
    return res.status(503).json({ error: 'DATABASE_URL is not set in the Vercel environment.' });
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
// Not named public/: Vercel would serve that from its CDN, bypassing the password.
// The build the page is running, so open tabs can tell when a newer one is live.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || `local-${Date.now()}`;
// Always revalidate page files so a refresh never shows an old version.
app.use(express.static(path.join(__dirname, 'web'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

async function fileToText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    return pdfToText(file.buffer);
  }
  if (name.endsWith('.docx')) {
    return docxToText(file.buffer);
  }
  if (/\.(txt|md|text)$/.test(name) || file.mimetype.startsWith('text/')) {
    return file.buffer.toString('utf-8');
  }
  throw new Error(`Unsupported file type for ${file.originalname}. Upload PDF, Word (.docx) or plain text.`);
}

// Full card for the shortlist tab (High potential only).
function defaultRejection(r) {
  const first = (r.candidate_name || 'there').split(/\s+/)[0];
  return {
    type: 'DELAYED_REJECTION',
    recipient_email: r.deliverables.resend_email_draft.recipient_email,
    subject: 'Your application to Kargo',
    body_text: `Hi ${first},\n\nThank you for your interest in Kargo and for the time you put into your application. After careful review, we won't be moving forward for this role.\n\nI appreciate you considering us and wish you the very best in your search.\n\nArjun Mehta\nFounder, Kargo`,
  };
}

function rejectionDraft(r) {
  const current = r.deliverables.resend_email_draft;
  if (current.type === 'DELAYED_REJECTION') return current;
  return r.deliverables.fallback_rejection_draft || defaultRejection(r);
}

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
      rejection_email_draft: rejectionDraft(r),
    },
    status: r.status,
    email_status: r.email_status,
    email_history: r.email_history,
    shortlisted_by_founder: Boolean(r.shortlisted_by_founder),
  };
}

// One-line row for the review queue: enough to decide, no full brief.
function conciseView(r) {
  const last = r.email_history[r.email_history.length - 1] || null;
  return {
    candidate_id: r.candidate_id,
    candidate_name: r.candidate_name,
    selected_role: r.selected_role,
    evaluated_at: r.evaluation_timestamp,
    category: r.categorization.category,
    match_score_pct: r.scoring.match_score_pct,
    total_risk_score: r.scoring.total_risk_score,
    risk_flags: r.risk_assessment.active_risk_flags.map(f => f.flag),
    reason: r.categorization.recommendation_reason,
    closest_historical_match: r.categorization.closest_historical_match,
    status: r.status,
    email_status: r.email_status,
    email: r.deliverables.resend_email_draft,
    rejection_email: rejectionDraft(r),
    last_email_event: last,
  };
}

const byScore = (a, b) =>
  b.scoring.match_score_pct - a.scoring.match_score_pct ||
  a.scoring.total_risk_score - b.scoring.total_risk_score;
const isRejection = r => r.deliverables.resend_email_draft.type === 'DELAYED_REJECTION';

// Records scored under an older rubric stay in the audit log only.
const currentRecords = async () => (await store.readAll()).filter(r => r.rubric_version === RUBRIC_VERSION);

app.get('/api/config', (req, res) => {
  res.json({
    llm_configured: llm.isConfigured(),
    llm_provider: llm.provider(),
    resend_configured: Boolean(process.env.RESEND_API_KEY),
    calendly_url: process.env.CALENDLY_URL || null,
    email_from: process.env.RESEND_FROM || 'Arjun at Kargo <onboarding@resend.dev>',
    email_override_to: overrideTo() || null,
    rejection_delay_hours: REJECTION_DELAY_HOURS,
    model: llm.activeModel(),
    storage: store.backendName(),
    rubric_version: RUBRIC_VERSION,
    build_id: BUILD_ID,
    max_files_per_upload: MAX_FILES,
  });
});

// Which list a candidate currently appears in, so the page can jump to them.
function whereShown(r) {
  if (r.deliverables.resend_email_draft.type === 'DELAYED_REJECTION') return 'rejections';
  if (r.categorization.category === 'HIGH_POTENTIAL' || r.shortlisted_by_founder) return 'shortlist';
  return 'medium';
}

app.post('/api/candidates', upload.array('cv'), async (req, res) => {
  const role = String(req.body.role || '').toUpperCase();
  if (!['PM', 'SPM'].includes(role)) return res.status(400).json({ error: 'Select a role: PM or SPM.' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Attach at least one CV.' });

  // Name/email overrides only make sense for a single upload.
  const overrides = req.files.length === 1 ? { name: req.body.name, email: req.body.email } : {};
  const results = [];
  const existing = await currentRecords();

  for (const file of req.files) {
    try {
      // The exact same file for the same role was already evaluated: don't
      // score it again or send a second email; point to the existing record.
      const sourceHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const dup = existing.find(r => r.source_hash === sourceHash && r.role_code === role);
      if (dup) {
        results.push({
          file: file.originalname,
          duplicate: true,
          candidate_id: dup.candidate_id,
          candidate_name: dup.candidate_name,
          category: dup.categorization.category,
          where: whereShown(dup),
          evaluated_at: dup.evaluation_timestamp,
        });
        continue;
      }
      const rawText = await fileToText(file);
      const record = await evaluateCv({
        rawText,
        roleCode: role,
        overrides: { ...overrides, filename: file.originalname },
        candidateId: await store.nextCandidateId(),
        calendlyUrl: process.env.CALENDLY_URL,
      });
      record.source_file = file.originalname;
      record.source_hash = sourceHash;
      await store.insertWithFreshId(record);
      existing.push(record);
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
        candidate_name: record.candidate_name,
        where: whereShown(record),
        evaluated_at: record.evaluation_timestamp,
      });
    } catch (err) {
      console.error(`Evaluation failed for ${file.originalname}:`, err);
      results.push({ file: file.originalname, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/dashboard', async (req, res) => {
  const all = await currentRecords();
  const high = all
    // High potential, plus Medium candidates Arjun chose to reconsider.
    .filter(r => (r.categorization.category === 'HIGH_POTENTIAL' || r.shortlisted_by_founder) && r.status !== 'PASSED_BY_FOUNDER')
    .sort(byScore)
    .map(dashboardView);

  res.json({
    candidates: high,
    stats: {
      total_evaluated: all.length,
      high: all.filter(r => r.categorization.category === 'HIGH_POTENTIAL').length,
      medium: all.filter(r => r.categorization.category === 'MEDIUM_POTENTIAL').length,
      auto_rejected: all.filter(r => r.categorization.category === 'LOW_POTENTIAL').length,
      medium_awaiting: all.filter(r => r.categorization.category === 'MEDIUM_POTENTIAL' && r.status === 'AWAITING_FOUNDER' && !r.shortlisted_by_founder).length,
      rejections_queued: all.filter(r => r.email_status === 'QUEUED').length,
      invites_sent: all.filter(r => r.status === 'INVITED').length,
    },
  });
});

// Review queue: Medium candidates still in play, plus every rejection email
// (Low auto-rejects and candidates Arjun passed on), as concise rows.
app.get('/api/review', async (req, res) => {
  const all = await currentRecords();
  res.json({
    medium: all
      .filter(r => r.categorization.category === 'MEDIUM_POTENTIAL' && !isRejection(r) && !r.shortlisted_by_founder)
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
  const { subject, body_text, recipient_email, draft } = req.body || {};
  const rec = await store.update(req.params.id, r => {
    let d = r.deliverables.resend_email_draft;
    if (draft === 'rejection' && d.type !== 'DELAYED_REJECTION') {
      // Edit the pre-written rejection that Pass / Send rejection mail will use.
      if (!r.deliverables.fallback_rejection_draft) r.deliverables.fallback_rejection_draft = defaultRejection(r);
      d = r.deliverables.fallback_rejection_draft;
    }
    if (typeof subject === 'string') d.subject = subject;
    if (typeof body_text === 'string') d.body_text = body_text;
    if (typeof recipient_email === 'string') d.recipient_email = recipient_email.trim();
  });
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ ok: true });
});

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
// Full detail for one candidate (the Review queue's "Open detailed summary").
app.get('/api/candidates/:id', async (req, res) => {
  const rec = await store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ ...dashboardView(rec), full_evaluation_rationale: rec.audit_log.full_evaluation_rationale });
});

// Arjun moves a Medium candidate from the Review queue onto the Shortlist.
app.post('/api/candidates/:id/reconsider', async (req, res) => {
  let error = null;
  const rec = await store.update(req.params.id, r => {
    if (r.categorization.category !== 'MEDIUM_POTENTIAL') { error = 'Only medium-potential candidates can be reconsidered.'; return; }
    if (r.status !== 'AWAITING_FOUNDER') { error = 'This candidate has already been decided.'; return; }
    r.shortlisted_by_founder = true;
    r.founder_decision = { decision: 'RECONSIDER', at: new Date().toISOString() };
  });
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  if (error) return res.status(409).json({ error });
  res.json({ ok: true });
});

app.post('/api/candidates/:id/pass', async (req, res) => {
  const rec = await store.update(req.params.id, r => {
    if (['SENT', 'SCHEDULED'].includes(r.email_status)) return;
    r.status = 'PASSED_BY_FOUNDER';
    r.founder_decision = { decision: 'PASS', note: (req.body && req.body.note) || '', at: new Date().toISOString() };
    r.deliverables.resend_email_draft = rejectionDraft(r);
    r.email_status = 'QUEUED';
  });
  if (!rec) return res.status(404).json({ error: 'Candidate not found.' });
  if (rec.status !== 'PASSED_BY_FOUNDER') return res.status(409).json({ error: 'Invite already sent; cannot pass.' });
  res.json({ ok: true });
});

// One click: schedule every queued rejection via Resend, delivered after the delay.
app.post('/api/rejections/send-batch', async (req, res) => {
  const queued = (await currentRecords()).filter(r => r.email_status === 'QUEUED');
  const scheduledAt = new Date(Date.now() + REJECTION_DELAY_HOURS * 3600 * 1000).toISOString();
  let scheduled = 0;
  const failures = [];

  for (const r of queued) {
    const d = r.deliverables.resend_email_draft;
    try {
      const result = await sendEmail({ to: d.recipient_email, subject: d.subject, text: d.body_text, scheduledAt });
      await store.update(r.candidate_id, x => {
        x.email_status = 'SCHEDULED';
        x.email_history.push({ type: d.type, resend_id: result.id, delivered_to: result.delivered_to, scheduled_at: scheduledAt, at: new Date().toISOString() });
      });
      scheduled++;
    } catch (err) {
      failures.push({ candidate_id: r.candidate_id, error: err.message });
      if (/RESEND_API_KEY/.test(err.message)) break;
    }
  }
  const allFailed = failures.length && !scheduled;
  res.status(allFailed ? 502 : 200).json({
    scheduled,
    scheduled_at: scheduledAt,
    failures,
    ...(allFailed ? { error: `No rejection mails were sent: ${failures[0].error}` } : {}),
  });
});

// Upload limits and other errors come back as JSON the dashboard can show.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_COUNT' ? `Upload at most ${MAX_FILES} CVs at a time here.`
      : err.code === 'LIMIT_FILE_SIZE' ? 'Each CV must be under 4 MB.' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Vercel imports the app; locally it runs as a normal server.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Kargo hiring dashboard running at http://localhost:${PORT} (storage: ${store.backendName()}, LLM: ${llm.provider()})`);
  });
}

module.exports = app;

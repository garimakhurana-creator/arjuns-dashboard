// End-to-end evaluation of one CV: redact, extract, score, route, then write
// the brief and email. Produces a record in Kargo's evaluation output schema,
// plus the internal fields the dashboard and audit log need.

const {
  getRole,
  clampScore,
  computeMatchScore,
  computeRiskScore,
  categorize,
  deriveRiskFlagsFromExtraction,
  mergeRiskFlags,
  RISKS,
} = require('./rubric');
const { extractAndRedact } = require('./pii');
const llm = require('./llm');

function personalize(text, pii, calendlyUrl) {
  return text
    .replace(/\[Candidate Name\]/g, pii.name.split(' ')[0])
    .replace(/\[Calendly Link\]/g, calendlyUrl || '[Calendly Link]');
}

function riskSummary(flags) {
  if (!flags.length) return 'No critical risk flags detected.';
  return flags.map(f => `${RISKS[f.flag].label} (+${f.points}): ${f.evidence}`).join(' | ');
}

// Builds the stored record from already-computed pieces. Kept separate from
// the LLM calls so it can be tested with fixture data.
function buildRecord({ candidateId, roleCode, pii, extraction, evaluation, deliverables, calendlyUrl, now }) {
  const role = getRole(roleCode);

  const parameter_scores = {};
  for (const p of role.parameters) {
    const e = evaluation.parameter_scores[p.key];
    parameter_scores[p.key] = { score: clampScore(e.score), evidence: e.evidence };
  }

  const flags = mergeRiskFlags(evaluation.active_risk_flags || [], deriveRiskFlagsFromExtraction(extraction));
  const match = computeMatchScore(roleCode, parameter_scores);
  const risk = computeRiskScore(flags);
  const category = categorize(match, risk);
  const surfaced = category !== 'LOW_POTENTIAL';

  const brief = deliverables.interview_brief;
  const email = deliverables.resend_email_draft;
  const fallback = deliverables.fallback_rejection_draft;

  return {
    candidate_id: candidateId,
    candidate_name: pii.name,
    selected_role: role.label,
    role_code: roleCode,
    evaluation_timestamp: now.toISOString(),
    scoring: {
      match_score_pct: match,
      total_risk_score: risk,
      parameter_scores,
    },
    risk_assessment: {
      active_risk_flags: flags,
      risk_summary: riskSummary(flags),
    },
    categorization: {
      category,
      surfaced_to_arjun_dashboard: surfaced,
      closest_historical_match: evaluation.closest_historical_match,
      recommendation_reason: evaluation.recommendation_reason,
    },
    audit_log: {
      full_evaluation_rationale: evaluation.full_evaluation_rationale,
      extracted_candidate_data: extraction,
      model: llm.activeModel(),
      pii_redacted_before_llm: true,
    },
    deliverables: {
      interview_brief: { ...brief, interview_probes: brief.interview_probes.slice(0, 3) },
      resend_email_draft: {
        type: surfaced ? 'INTERVIEW_INVITE' : 'DELAYED_REJECTION',
        recipient_email: pii.email,
        subject: personalize(email.subject, pii, calendlyUrl),
        body_text: personalize(email.body_text, pii, calendlyUrl),
      },
      fallback_rejection_draft: fallback
        ? {
            type: 'DELAYED_REJECTION',
            recipient_email: pii.email,
            subject: personalize(fallback.subject, pii, calendlyUrl),
            body_text: personalize(fallback.body_text, pii, calendlyUrl),
          }
        : null,
    },
    // Workflow state. Arjun's decision is the last manual step.
    status: surfaced ? 'AWAITING_FOUNDER' : 'AUTO_REJECTED',
    email_status: surfaced ? 'DRAFT' : 'QUEUED',
    email_history: [],
    contact: { phone: pii.phone },
  };
}

async function evaluateCv({ rawText, roleCode, overrides, candidateId, calendlyUrl }) {
  const { pii, redactedText } = extractAndRedact(rawText, overrides);
  if (redactedText.trim().length < 200) {
    throw new Error('Could not read enough text from this CV (scanned PDF?). Upload a text-based PDF or .txt.');
  }

  const extraction = await llm.extractSignals(redactedText, roleCode);
  const evaluation = await llm.evaluateCandidate(redactedText, extraction, roleCode);

  // Score before generating deliverables so the brief and email match the category.
  const provisional = buildRecord({
    candidateId, roleCode, pii, extraction, evaluation, calendlyUrl, now: new Date(),
    deliverables: {
      interview_brief: { interview_probes: [] },
      resend_email_draft: { subject: '', body_text: '' },
      fallback_rejection_draft: null,
    },
  });

  const deliverables = await llm.generateDeliverables({
    roleCode,
    category: provisional.categorization.category,
    matchScore: provisional.scoring.match_score_pct,
    riskScore: provisional.scoring.total_risk_score,
    evaluation,
    extraction,
  });

  return buildRecord({ candidateId, roleCode, pii, extraction, evaluation, deliverables, calendlyUrl, now: new Date() });
}

module.exports = { evaluateCv, buildRecord };

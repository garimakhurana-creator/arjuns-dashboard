const test = require('node:test');
const assert = require('node:assert');
const {
  computeMatchScore, computeRiskScore, categorize, deriveRiskFlagsFromExtraction, mergeRiskFlags,
} = require('../lib/rubric');
const { buildRecord } = require('../lib/pipeline');
const { extractAndRedact } = require('../lib/pii');
const sample = require('../fixtures/sample-extraction.json').extracted_candidate_data;

const spmScores = (a, b, c, d) => ({
  p1_technical_integration: { score: a, evidence: 'x' },
  p2_domain_depth: { score: b, evidence: 'x' },
  p3_autonomous_scrappiness: { score: c, evidence: 'x' },
  p4_cross_functional_alignment: { score: d, evidence: 'x' },
});

test('match score applies SPM weights', () => {
  // 30 + 20 + 25 + 16
  assert.strictEqual(computeMatchScore('SPM', spmScores(5, 4, 5, 4)), 91);
  assert.strictEqual(computeMatchScore('SPM', spmScores(5, 5, 5, 5)), 100);
  assert.strictEqual(computeMatchScore('SPM', spmScores(1, 1, 1, 1)), 20);
});

test('match score applies PM weights', () => {
  const s = {
    p1_customer_discovery: { score: 4 }, p2_scrappiness_velocity: { score: 3 },
    p3_engineering_alignment: { score: 5 }, p4_metric_driven_adoption: { score: 2 },
  };
  // 24 + 18 + 20 + 8
  assert.strictEqual(computeMatchScore('PM', s), 70);
});

test('risk score sums distinct flags and caps at 100', () => {
  assert.strictEqual(computeRiskScore([]), 0);
  assert.strictEqual(computeRiskScore(['INFORMATION_GAP_RISK', 'INFORMATION_GAP_RISK']), 20);
  assert.strictEqual(computeRiskScore(['ENTERPRISE_DEPENDENCY_RISK', 'DOMAIN_MISALIGNMENT_RISK', 'INFORMATION_GAP_RISK']), 85);
});

test('categorization matrix', () => {
  assert.strictEqual(categorize(85, 20), 'HIGH_POTENTIAL');
  assert.strictEqual(categorize(91, 0), 'HIGH_POTENTIAL');
  assert.strictEqual(categorize(84.9, 0), 'MEDIUM_POTENTIAL');
  assert.strictEqual(categorize(65, 50), 'MEDIUM_POTENTIAL');
  assert.strictEqual(categorize(64.9, 0), 'LOW_POTENTIAL');
  assert.strictEqual(categorize(95, 55), 'LOW_POTENTIAL');
  // Gap in the spec: strong match, moderate risk -> review queue, not auto-reject.
  assert.strictEqual(categorize(90, 35), 'MEDIUM_POTENTIAL');
});

test('extraction-derived flags are merged with evaluator flags', () => {
  const derived = deriveRiskFlagsFromExtraction(sample);
  assert.deepStrictEqual(derived.map(f => f.flag), ['INFORMATION_GAP_RISK']);
  const merged = mergeRiskFlags([{ flag: 'INFORMATION_GAP_RISK', evidence: 'eval' }], derived);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].evidence, 'eval');
});

test('sample SPM candidate routes to HIGH and personalises the invite', () => {
  const rec = buildRecord({
    candidateId: 'KARGO-2026-001',
    roleCode: 'SPM',
    pii: { name: 'Priya Nair', email: 'priya@example.com', phone: null },
    extraction: sample,
    evaluation: {
      parameter_scores: spmScores(5, 4, 5, 4),
      active_risk_flags: [],
      closest_historical_match: 'Rohan Desai',
      recommendation_reason: 'r',
      full_evaluation_rationale: 'f',
    },
    deliverables: {
      interview_brief: { summary: 's', why_ranked_here: 'w', key_strengths: [], risk_factors: [], interview_probes: ['a', 'b', 'c', 'd'] },
      resend_email_draft: { type: 'INTERVIEW_INVITE', subject: 'Kargo & [Candidate Name]', body_text: 'Hi [Candidate Name], book: [Calendly Link]' },
      fallback_rejection_draft: null,
    },
    calendlyUrl: 'https://cal.example/arjun',
    now: new Date('2026-09-28T12:00:00Z'),
  });
  assert.strictEqual(rec.scoring.match_score_pct, 91);
  assert.strictEqual(rec.scoring.total_risk_score, 20);
  assert.strictEqual(rec.categorization.category, 'HIGH_POTENTIAL');
  assert.strictEqual(rec.categorization.surfaced_to_arjun_dashboard, true);
  assert.strictEqual(rec.deliverables.interview_brief.interview_probes.length, 3);
  assert.strictEqual(rec.deliverables.resend_email_draft.body_text, 'Hi Priya, book: https://cal.example/arjun');
  assert.strictEqual(rec.deliverables.resend_email_draft.recipient_email, 'priya@example.com');
});

test('PII is stripped before LLM context', () => {
  const cv = `PRIYA NAIR\npriya.nair@gmail.com | +91 98765 43210 | linkedin.com/in/priyanair\n\nProduct Manager at FreightCo. Priya led carrier integrations.`;
  const { pii, redactedText } = extractAndRedact(cv);
  assert.strictEqual(pii.name, 'Priya Nair');
  assert.strictEqual(pii.email, 'priya.nair@gmail.com');
  assert.ok(!/priya|nair|98765|gmail|linkedin/i.test(redactedText), redactedText);
  assert.ok(redactedText.includes('FreightCo'));
});

test('rubric weights sum to 100% and every parameter has all three levels', () => {
  const { ROLES } = require('../lib/rubric');
  for (const [code, role] of Object.entries(ROLES)) {
    const total = role.parameters.reduce((s, p) => s + p.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${code} weights sum to ${total}`);
    for (const p of role.parameters) {
      assert.ok(p.levels.low && p.levels.mid && p.levels.high && p.calibration, `${code}.${p.key}`);
    }
  }
});

test('calibration treats Vikram Nair and Lavanya Iyer as misfits', () => {
  const { CALIBRATION } = require('../lib/rubric');
  const misfits = CALIBRATION.split('MISFITS')[1];
  assert.ok(misfits.includes('Vikram Nair') && misfits.includes('Lavanya Iyer'));
  assert.ok(!CALIBRATION.split('MISFITS')[0].includes('Lavanya Iyer ('));
});

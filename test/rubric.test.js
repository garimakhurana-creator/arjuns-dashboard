const test = require('node:test');
const assert = require('node:assert');
const {
  computeMatchScore, computeRiskScore, categorize, deriveRiskFlagsFromExtraction, mergeRiskFlags,
} = require('../lib/rubric');
const { buildRecord } = require('../lib/pipeline');
const { extractAndRedact } = require('../lib/pii');
const sample = require('../fixtures/sample-extraction.json').extracted_candidate_data;

const spmScores = (a, b, c, d) => ({
  p1_integration_judgment: { score: a, evidence: 'x' },
  p2_operations_depth: { score: b, evidence: 'x' },
  p3_autonomous_calls: { score: c, evidence: 'x' },
  p4_cross_functional_unblocking: { score: d, evidence: 'x' },
});

test('match score applies SPM weights', () => {
  // weights 30/30/25/15: 30 + 24 + 25 + 12
  assert.strictEqual(computeMatchScore('SPM', spmScores(5, 4, 5, 4)), 91);
  assert.strictEqual(computeMatchScore('SPM', spmScores(5, 5, 5, 5)), 100);
  assert.strictEqual(computeMatchScore('SPM', spmScores(1, 1, 1, 1)), 20);
});

test('match score applies PM weights', () => {
  const s = {
    p1_operations_immersion: { score: 4 }, p2_ship_and_kill: { score: 3 },
    p3_unforced_adoption: { score: 5 }, p4_engineering_trust: { score: 2 },
  };
  // weights 30/25/25/20: 24 + 15 + 25 + 8
  assert.strictEqual(computeMatchScore('PM', s), 72);
});

test('risk score sums distinct flags and caps at 100', () => {
  assert.strictEqual(computeRiskScore([]), 0);
  assert.strictEqual(computeRiskScore(['INFORMATION_GAP_RISK', 'INFORMATION_GAP_RISK']), 20);
  assert.strictEqual(computeRiskScore(['NO_OPERATIONS_EXPOSURE_RISK', 'STRUCTURE_DEPENDENCY_RISK', 'INFORMATION_GAP_RISK']), 80);
  // Retired flag keys from the earlier rubric carry no points.
  assert.strictEqual(computeRiskScore(['ENTERPRISE_DEPENDENCY_RISK']), 0);
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

test('calibration follows the problem statement ratings', () => {
  const { HISTORICAL_HIRES, CALIBRATION } = require('../lib/rubric');
  const fit = Object.fromEntries(HISTORICAL_HIRES.map(h => [h.name, h.fit]));
  assert.strictEqual(HISTORICAL_HIRES.length, 8);
  for (const n of ['Rohan Desai', 'Sunita Krishnamurthy', 'Aditya Shetty', 'Meghna Tiwari', 'Lavanya Iyer']) assert.strictEqual(fit[n], 'top', n);
  for (const n of ['Vikram Nair', 'Rahul Bose', 'Preetham Rao']) assert.strictEqual(fit[n], 'misfit', n);
  const [top, misfit] = CALIBRATION.split('MEETS OR BELOW EXPECTATIONS');
  assert.ok(top.includes('Lavanya Iyer, hired as Product Manager') && misfit.includes('Preetham Rao, hired as Backend Engineer'));
});

test('new extraction signals raise operations and structure flags', () => {
  const extraction = {
    operations_signals: { has_hands_on_operations_experience: false, has_worked_alongside_operations_teams: false },
    organisation_signals: { has_early_stage_experience: false, only_large_or_layered_organisations: true },
    extracted_gaps_and_risks: { missing_impact_metrics: false, vague_ownership_descriptions: false, detected_risk_flags: [] },
  };
  assert.deepStrictEqual(deriveRiskFlagsFromExtraction(extraction).map(f => f.flag), ['NO_OPERATIONS_EXPOSURE_RISK', 'STRUCTURE_DEPENDENCY_RISK']);
  extraction.operations_signals.has_worked_alongside_operations_teams = true;
  extraction.organisation_signals.has_early_stage_experience = true;
  assert.deepStrictEqual(deriveRiskFlagsFromExtraction(extraction), []);
});

test('headings and job titles are never taken as the candidate name', () => {
  const { extractAndRedact, nameFromFilename } = require('../lib/pii');
  const cv = 'Associate Product Manager\n| | |\nPROFESSIONAL SUMMARY\nProduct manager who led carrier integrations.';
  const { pii, redactedText } = extractAndRedact(cv, { filename: '04_arjun_verma.pdf' });
  assert.strictEqual(pii.name, 'Arjun Verma');
  assert.ok(redactedText.includes('Product Manager'), 'job title must survive redaction');
  assert.strictEqual(extractAndRedact('Professional Summary\nCore Skills\n').pii.name, 'Candidate');
  assert.strictEqual(nameFromFilename('spm_16_siddharth_rao.pdf'), 'Siddharth Rao');
  assert.strictEqual(nameFromFilename('scan0001.pdf'), null);
});

test('test mode delivers every email to EMAIL_OVERRIDE_TO and notes the real recipient', async () => {
  const { sendEmail } = require('../lib/resend');
  const sent = [];
  const realFetch = global.fetch;
  const saved = { key: process.env.RESEND_API_KEY, over: process.env.EMAIL_OVERRIDE_TO };
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'x' }) }; };
  try {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_OVERRIDE_TO = 'me@example.com';
    const r = await sendEmail({ to: 'candidate@example.com', subject: 'Hi', text: 'Body' });
    assert.deepStrictEqual(sent[0].to, ['me@example.com']);
    assert.ok(sent[0].text.startsWith('[Test mode: this email would have gone to candidate@example.com]'));
    assert.strictEqual(r.delivered_to, 'me@example.com');
    process.env.EMAIL_OVERRIDE_TO = '';
    await sendEmail({ to: 'candidate@example.com', subject: 'Hi', text: 'Body' });
    assert.deepStrictEqual(sent[1].to, ['candidate@example.com']);
    assert.strictEqual(sent[1].text, 'Body');
  } finally {
    global.fetch = realFetch;
    process.env.RESEND_API_KEY = saved.key || '';
    process.env.EMAIL_OVERRIDE_TO = saved.over || '';
  }
});

test('OCR-split names and bracketed filenames are still redacted', () => {
  const { extractAndRedact, nameFromFilename } = require('../lib/pii');
  assert.strictEqual(nameFromFilename('Garima Khurana _ Resume (2025).pdf'), 'Garima Khurana');
  const { pii, redactedText } = extractAndRedact('Mobile: 9999 | Ga rima Kh urana\nEducation\nGarima led a team.', { filename: 'Garima Khurana _ Resume (2025).pdf' });
  assert.strictEqual(pii.name, 'Garima Khurana');
  assert.ok(!/ga\s?rima|kh\s?urana/i.test(redactedText), redactedText);
  assert.ok(redactedText.includes('Education'));
});

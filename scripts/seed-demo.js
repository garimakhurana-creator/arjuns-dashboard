// Seeds data/candidates.json with three demo evaluations (High, Medium, Low)
// so the dashboard and audit log can be explored without API keys. The High
// candidate uses fixtures/sample-extraction.json. Run: npm run seed
require('../lib/env').loadDotEnv();
const store = require('../lib/store');
const { buildRecord } = require('../lib/pipeline');
const sample = require('../fixtures/sample-extraction.json').extracted_candidate_data;

const invite = (extra = '') => ({
  type: 'INTERVIEW_INVITE',
  subject: 'Kargo & [Candidate Name] - Product Leadership',
  body_text: `Hi [Candidate Name],\n\nI read through your background and ${extra}. That's close to how our best product people work at Kargo.\n\nWould you be open to a 45-minute conversation? Grab any slot here: [Calendly Link]\n\nArjun Mehta\nFounder, Kargo`,
});
const rejection = {
  type: 'DELAYED_REJECTION',
  subject: 'Your application to Kargo',
  body_text: 'Hi [Candidate Name],\n\nThank you for your time and interest in Kargo. After careful review we won\'t be moving forward for this role. I appreciate you considering us and wish you the very best.\n\nArjun Mehta\nFounder, Kargo',
};

const demos = [
  {
    roleCode: 'SPM',
    pii: { name: 'Demo High Candidate', email: 'high.demo@example.com', phone: null },
    extraction: sample,
    evaluation: {
      parameter_scores: {
        p1_integration_judgment: { score: 5, evidence: 'Built carrier dispatch APIs handling 10k+ daily shipments; integrated EDI 214 status webhooks with enterprise TMS.' },
        p2_operations_depth: { score: 4, evidence: 'Spent 2 weeks on-site shadowing freight dispatchers at JNPT port yard.' },
        p3_autonomous_calls: { score: 5, evidence: 'Shipped 0-to-1 tracking module in 6 weeks without a dedicated designer.' },
        p4_cross_functional_unblocking: { score: 4, evidence: 'Integrations work implies partner coordination, but no explicit deal-unblocking story.' },
      },
      active_risk_flags: [{ flag: 'INFORMATION_GAP_RISK', evidence: 'Adoption and revenue outcomes of the tracking module are not quantified.' }],
      closest_historical_match: 'Rohan Desai (top performer)',
      recommendation_reason: 'Matches the Rohan Desai pattern: hands-on carrier API depth, on-the-ground discovery at a port yard, and 0-to-1 shipping in weeks.',
      full_evaluation_rationale: 'DEMO RECORD. P1=5: direct carrier API and EDI 214 work at scale. P2=4: freight domain and field shadowing. P3=5: 0-to-1 in 6 weeks without design support. P4=4: partner-facing but no explicit sales unblocking. Information gap flagged because the tracking module\'s outcomes are not quantified.',
    },
    deliverables: {
      interview_brief: {
        summary: 'Carrier-integrations PM with 5 years of product experience in logistics. Has built dispatch APIs at 10k+/day scale and does field discovery.',
        why_ranked_here: 'Closest match to Rohan Desai: technical integration depth plus ground-level ops exposure is the pattern behind Kargo\'s best SPM hires.',
        key_strengths: ['Carrier API + EDI 214 depth', 'On-site dispatcher shadowing at JNPT', '0-to-1 shipping in 6 weeks'],
        risk_factors: ['Outcomes of the tracking module not quantified', 'No explicit enterprise deal-unblocking example'],
        interview_probes: [
          'Walk me through a build-vs-buy call on a carrier integration. What did you pick, what did it cost, and would you choose the same again?',
          'What did you see at the JNPT yard that changed the roadmap, and which specific feature came out of it?',
          'How did adoption of the tracking module look 90 days after launch? Give numbers.',
        ],
      },
      resend_email_draft: invite('your carrier dispatch API work, and especially the two weeks at the JNPT yard, stood out'),
      fallback_rejection_draft: rejection,
    },
  },
  {
    roleCode: 'PM',
    pii: { name: 'Demo Medium Candidate', email: 'medium.demo@example.com', phone: null },
    extraction: { ...sample, extracted_gaps_and_risks: { missing_impact_metrics: false, vague_ownership_descriptions: false, detected_risk_flags: [] } },
    evaluation: {
      parameter_scores: {
        p1_operations_immersion: { score: 4, evidence: 'Ran 30+ interviews with warehouse supervisors.' },
        p2_ship_and_kill: { score: 3, evidence: 'Shipped features at a Series C company; no 0-to-1 builds.' },
        p3_unforced_adoption: { score: 4, evidence: 'Ran two-week sprints with a 6-engineer squad.' },
        p4_engineering_trust: { score: 3, evidence: 'Mentions a 22% usage lift, but it came from a mandated rollout.' },
      },
      active_risk_flags: [{ flag: 'NO_OPERATIONS_EXPOSURE_RISK', evidence: 'Primarily horizontal SaaS; logistics exposure limited to one customer segment.' }],
      closest_historical_match: 'Lavanya Iyer (top performer)',
      recommendation_reason: 'Discovery instincts resemble Sunita K., but 0-to-1 velocity is unproven and logistics depth is thin.',
      full_evaluation_rationale: 'DEMO RECORD. Discovery is strong, execution is solid but in a mature environment. Domain misalignment flagged.',
    },
    deliverables: {
      interview_brief: {
        summary: 'Horizontal SaaS PM with strong field discovery habits. Execution is proven at scale but not from zero.',
        why_ranked_here: 'Discovery matches the Sunita K. pattern; scrappiness and domain adaptability are the open questions.',
        key_strengths: ['Field interviews with warehouse staff', 'Sprint discipline'],
        risk_factors: ['No 0-to-1 evidence', 'Adoption lift was mandated'],
        interview_probes: [
          'Tell me about something you shipped with no team around you. What did you cut to ship it?',
          'Your 22% usage lift: how much of it would have happened without the mandate?',
          'What did the warehouse interviews reveal that the data didn\'t?',
        ],
      },
      resend_email_draft: invite('your warehouse supervisor interviews caught my eye'),
      fallback_rejection_draft: rejection,
    },
  },
  {
    roleCode: 'SPM',
    pii: { name: 'Demo Low Candidate', email: 'low.demo@example.com', phone: null },
    extraction: {
      ...sample,
      pedigree_classification: { has_early_stage_0_to_1: false, has_enterprise_only_background: true, company_types_detected: ['ENTERPRISE_LARGE_CORP'] },
      extracted_gaps_and_risks: { missing_impact_metrics: true, vague_ownership_descriptions: true, detected_risk_flags: [] },
    },
    evaluation: {
      parameter_scores: {
        p1_integration_judgment: { score: 3, evidence: 'Managed ERP module roadmaps; integrations were owned by a platform team.' },
        p2_operations_depth: { score: 2, evidence: 'No freight or operations exposure.' },
        p3_autonomous_calls: { score: 1, evidence: 'All roles at 10k+ employee companies with PMM, analytics and design support.' },
        p4_cross_functional_unblocking: { score: 3, evidence: 'Coordinated release trains across 4 teams.' },
      },
      active_risk_flags: [{ flag: 'STRUCTURE_DEPENDENCY_RISK', evidence: '12 years across two large ERP vendors; no early-stage work.' }],
      closest_historical_match: 'Preetham Rao (misfit)',
      recommendation_reason: 'Matches the Vikram Nair misfit pattern: enterprise dependency without 0-to-1 scrappiness.',
      full_evaluation_rationale: 'DEMO RECORD. Enterprise-only pedigree, no 0-to-1, no domain depth, outcomes not quantified. Auto-rejected; reasons retained for audit.',
    },
    deliverables: {
      interview_brief: { summary: 'Enterprise ERP PM.', why_ranked_here: 'Enterprise dependency misfit pattern.', key_strengths: ['Release coordination'], risk_factors: ['Enterprise dependency', 'No domain depth'], interview_probes: ['-', '-', '-'] },
      resend_email_draft: rejection,
      fallback_rejection_draft: null,
    },
  },
];

(async () => {
  if (store.backendName() !== 'local' && !process.argv.includes('--force')) {
    throw new Error('Refusing to seed demo candidates into Neon. Unset DATABASE_URL, or pass --force.');
  }
  for (const d of demos) {
    const rec = buildRecord({ ...d, candidateId: await store.nextCandidateId(), calendlyUrl: process.env.CALENDLY_URL, now: new Date() });
    rec.demo = true;
    await store.insert(rec);
    console.log(`${rec.candidate_id}  ${rec.categorization.category.padEnd(17)} match ${rec.scoring.match_score_pct}%  risk ${rec.scoring.total_risk_score}`);
  }
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});

// Calibrated rubrics, risk points and routing rules for Kargo PM / SPM hiring.
//
// Sources: the Case 2 problem statement (hire roles and last ratings), the 8
// past-hire CVs, and the PM / SPM job descriptions. The problem statement is
// explicit that the JD describes the role but does not predict success; the
// pattern in the hires does. So each parameter blends a JD requirement with
// the hire pattern, and the level descriptors cite hire evidence.
//
// Everything numeric lives here in plain code: the LLM only scores each
// parameter 1-5 against the level descriptors and names risk flags; the
// weighted match score, risk total and category are computed deterministically.

// Bump when parameters, weights or risks change. Records scored under an older
// version stay in the audit log but drop off the shortlist and review queue.
const RUBRIC_VERSION = '2026-09-28.v2';

// Kargo's 8 past hires, from the problem statement's ratings table plus the
// evidence in each CV. "top" = Exceeds Expectations; "misfit" = Meets or Below.
const HISTORICAL_HIRES = [
  {
    name: 'Rohan Desai', role: 'Head of Engineering', rating: 'Exceeds Expectations', fit: 'top',
    evidence: 'Three years doing import/export documentation at a CHA firm at JNPT before moving into software. Built an Excel shipment tracker nobody asked for, adopted by the 12-person ops team in two weeks; later built a Bill of Lading check as a weekend prototype that 30 colleagues used within a month. Works directly with forwarder ops teams without a product layer.',
  },
  {
    name: 'Sunita Krishnamurthy', role: 'Operations Lead', rating: 'Exceeds Expectations', fit: 'top',
    evidence: 'Seven years inside freight documentation and customs compliance (200+ shipments a month). When the FMS vendor changed its export format without notice, redesigned the team\'s workflow over a weekend; the process was kept permanently. Independent consultant owning migrations end to end with no oversight.',
  },
  {
    name: 'Aditya Shetty', role: 'Sales Lead', rating: 'Exceeds Expectations', fit: 'top',
    evidence: 'Port-services sales at JNPT, working alongside terminal operations at peak; understands berth windows, DO releases and documentation pressure first-hand. Self-sourced most of his territory. Ran a post-mortem on a lost freight-forwarder deal that became standard team practice.',
  },
  {
    name: 'Meghna Tiwari', role: 'Customer Success Manager', rating: 'Exceeds Expectations', fit: 'top',
    evidence: 'Two and a half years as a freight-forwarder documentation executive before SaaS. Resolved a 7pm customs hold overnight with the CHA before the client noticed. Her onboarding checklist and 30-60-90 framework became the team standard; 6% churn against a 24% team average.',
  },
  {
    name: 'Lavanya Iyer', role: 'Product Manager', rating: 'Exceeds Expectations', fit: 'top',
    evidence: 'Three years in carrier operations and supply-chain planning at a national 3PL before product: "domain-native, built before product, not from a desk". Sole PM at a Series A port and logistics SaaS; shipped 6 features and killed 2 on usage data; a visibility dashboard she started in Excel was adopted by 2 other teams. Engineering lead: "the first PM here who has made calls we trusted immediately."',
  },
  {
    name: 'Vikram Nair', role: 'Product Manager', rating: 'Meets Expectations', fit: 'misfit',
    evidence: 'Polished enterprise HR-tech PM: MBA, CPO certification, Reforge, PRD templates, a 4-person PM team with CTO and VP layers above, discovery through scheduled enterprise interviews. Strong on the spec, but with no exposure to operations-heavy work and no evidence of operating without structure.',
  },
  {
    name: 'Rahul Bose', role: 'Growth & Marketing Lead', rating: 'Meets Expectations', fit: 'misfit',
    evidence: 'Strong, well-measured fintech and HR-tech demand generation with no CMO above him, but no exposure to logistics or operations. Autonomy and metrics without domain grounding gave steady but unremarkable output.',
  },
  {
    name: 'Preetham Rao', role: 'Backend Engineer', rating: 'Below Expectations', fit: 'misfit',
    evidence: 'Deep technical skill, including REST/SFTP integrations with Delhivery, Bluedart and Ecom Express, but all inside a 12-engineer team at a 3,200-person e-commerce company. Integration experience from the software side only, with no time in operations. Technical depth alone did not predict success at Kargo.',
  },
];

const ROLES = {
  SPM: {
    label: 'Senior Product Manager',
    focus: 'Owns the integration and data layer (carrier systems, port portals, ERP and freight tools), the build / configure / stay-away calls, reliability and data-quality standards, cross-functional work on which integrations unlock or lose customers, and shaping how the PM function works. Could become Head of Product.',
    target_experience: '5–8 years of PM experience, owning a product area without senior PMs above making the calls.',
    parameters: [
      {
        key: 'p1_integration_judgment',
        name: 'Integration & Platform Judgment',
        weight: 0.30,
        source: 'JD: own the integration/data layer; clear build vs. configure vs. not-touch point of view; reliability standards.',
        calibration: 'Rohan Desai (Exceeds) vs. Preetham Rao (Below)',
        levels: {
          low: 'Feature- or front-end-level work; no ownership of integrations, APIs or data flows between systems.',
          mid: 'Has built or managed integrations competently, but as technical execution inside a large structured team or through vendor tools; little evidence of judging what to build, configure or avoid, or of reliability ownership. (Preetham Rao\'s profile.)',
          high: 'Owned integration or data-layer decisions for a platform working inside customers\' existing systems: chose what to build, configure or stay away from, set reliability or data-quality standards, and tied those calls to how customer operations actually run (Rohan Desai: replaced an unreliable data vendor with no data loss, cut P1 incidents 40%, translated field requirements directly into specs).',
        },
      },
      {
        key: 'p2_operations_depth',
        name: 'Ground-Level Operations Depth',
        weight: 0.30,
        source: 'Hire pattern (every Exceeds hire has it; every Meets/Below hire lacks it). JD: familiarity with operations-heavy industries at ground level is "a genuine advantage, not a nice-to-have".',
        calibration: 'Rohan Desai, Aditya Shetty, Lavanya Iyer (Exceeds) vs. Vikram Nair, Preetham Rao (Meets/Below)',
        levels: {
          low: 'No exposure to operations-heavy work; knows logistics only as a market, a customer segment or an API.',
          mid: 'Built or sold software for operations-heavy users and worked closely with them, but never did the operational work; or hands-on operations in an adjacent domain (manufacturing, field ops, supply-chain planning) without freight specifics.',
          high: 'Did the operational work in freight, logistics, port or supply-chain operations: documentation, customs, carrier coordination, dispatch, terminal or warehouse operations (Rohan Desai at a JNPT CHA firm, Aditya Shetty at JNPT terminal services, Lavanya Iyer in 3PL carrier ops).',
        },
      },
      {
        key: 'p3_autonomous_calls',
        name: 'Autonomous Calls in Ambiguity',
        weight: 0.25,
        source: 'JD: owned a product area without senior PMs above; no committee approves product decisions; time at an early-stage company. Hire pattern: owned outcomes end to end, including when things broke.',
        calibration: 'Sunita Krishnamurthy, Lavanya Iyer (Exceeds) vs. Vikram Nair (Meets)',
        levels: {
          low: 'Decisions made by committees, steering groups or senior PMs; the candidate executed or presented them.',
          mid: 'Owned an area inside an established PM organisation with handbooks, templates and senior oversight; limited evidence of calls made alone under uncertainty.',
          high: 'Was the most senior decision-maker for their area with no layer above; made consequential calls in ambiguity and owned the fallout (incidents, post-mortems, reversals), ideally at an early-stage company where the rules weren\'t written yet (Sunita K. redesigning a workflow over a weekend when a vendor broke it; Lavanya Iyer as sole PM owning outage post-mortems).',
        },
      },
      {
        key: 'p4_cross_functional_unblocking',
        name: 'Cross-Functional Unblocking & Standards',
        weight: 0.15,
        source: 'JD: work across sales, engineering and customer ops on which integrations unlock or lose customers; a roadmap everyone trusts; raise the bar for PM work by demonstrating it.',
        calibration: 'Aditya Shetty, Meghna Tiwari (Exceeds) vs. Vikram Nair (Meets: process built for a PM team, not outcomes)',
        levels: {
          low: 'Works within one function; roadmap shaped by whoever asks loudest; friction with engineering or sales.',
          mid: 'Keeps sales, engineering and customers informed with standard cadences; introduced templates or processes, but without clear outcomes attached.',
          high: 'Directly unblocked revenue or retention by connecting sales, engineering and customer operations (a stalled deal opened by an integration, a customer escalation driven to resolution); practices they created were adopted because they worked (Meghna Tiwari\'s onboarding framework, Aditya Shetty\'s loss post-mortem).',
        },
      },
    ],
  },
  PM: {
    label: 'Product Manager',
    focus: 'First PM on the core operations platform: shipment tracking, documentation workflows and real-time status visibility. Owns customer discovery, works directly with engineering, and builds the PM rhythms from scratch.',
    target_experience: '2–4 years of PM experience, ideally building something for the first time rather than maintaining it.',
    parameters: [
      {
        key: 'p1_operations_immersion',
        name: 'Ground-Level Operations Immersion',
        weight: 0.30,
        source: 'Hire pattern (every Exceeds hire has it). JD: genuine curiosity about how operations work at ground level; time inside freight forwarding operations, "not just over calls, but in the rooms where the work actually happens".',
        calibration: 'Lavanya Iyer, Sunita K., Meghna Tiwari (Exceeds) vs. Vikram Nair (Meets)',
        levels: {
          low: 'Understands users through surveys, analytics dashboards or scheduled remote interviews only; no operations exposure.',
          mid: 'Runs structured, frequent discovery with B2B users and turns it into clear specs, but in a non-operational domain or only remotely (Vikram Nair: 40+ enterprise interviews in HR tech).',
          high: 'Has done the operational work, or spent sustained time in the rooms where it happens (dispatch, documentation desks, ports, warehouses, carrier coordination), and turned spreadsheet or WhatsApp workarounds into structured software (Lavanya Iyer: 3 years in 3PL carrier ops; Rohan Desai: CHA documentation desk).',
        },
      },
      {
        key: 'p2_ship_and_kill',
        name: 'Ship, Learn & Kill in Short Cycles',
        weight: 0.25,
        source: 'JD: evidence of having shipped things, killed things and learned from both, preferably in short cycles; comfortable with no handbook, design system or sprint template.',
        calibration: 'Lavanya Iyer, Rohan Desai (Exceeds)',
        levels: {
          low: 'Maintains or optimises an existing product in long release cycles; depends on design systems, PM handbooks and large team structures.',
          mid: 'Ships steadily within an established startup process (bi-weekly sprints, existing templates); few examples of cutting something that wasn\'t working.',
          high: 'Built from zero in short cycles and made kill decisions from real usage data (Lavanya Iyer shipped 6 features and killed 2 to redirect capacity; Rohan Desai built a weekend prototype 30 colleagues used within a month).',
        },
      },
      {
        key: 'p3_unforced_adoption',
        name: 'Unforced Adoption with Operational Impact',
        weight: 0.25,
        source: 'JD 6-month success: at least two features customers use "without being asked to". Hire pattern: each Exceeds hire built something others adopted on their own.',
        calibration: 'Rohan Desai, Meghna Tiwari, Lavanya Iyer (Exceeds)',
        levels: {
          low: 'Reports outputs (features shipped) or vanity metrics (logins, pageviews) with no evidence anyone chose to use the work.',
          mid: 'Tracks adoption and retention after launch; adoption driven by rollouts, mandates or sales pushes rather than users choosing it.',
          high: 'Things they built were picked up voluntarily and spread, with a measured effect on operations: turnaround, errors, support load or exceptions (Rohan Desai\'s tracker adopted by 12 people in two weeks; Lavanya Iyer\'s dashboard adopted by 2 other teams; a pivot that cut one account\'s tickets by 60%).',
        },
      },
      {
        key: 'p4_engineering_trust',
        name: 'Engineering Trust & Self-Built Rhythm',
        weight: 0.20,
        source: 'JD: engineering knows what it is building three sprints out; build the rhythms a PM function needs (prioritisation, tracking whether something worked, communicating decisions).',
        calibration: 'Lavanya Iyer (Exceeds: "calls we trusted immediately") vs. Vikram Nair (Meets: process inside an existing PM team)',
        levels: {
          low: 'Vague specs, scope churn, friction with engineering, or no evidence of working directly with engineers.',
          mid: 'Writes clear stories and keeps engineering one sprint ahead; uses processes that already existed.',
          high: 'Engineering trusts their calls and knows the plan several sprints out; they created the rhythms themselves (prioritisation, post-launch tracking, API docs, post-mortems) where none existed.',
        },
      },
    ],
  },
};

const RISKS = {
  NO_OPERATIONS_EXPOSURE_RISK: {
    points: 30,
    label: 'No operations exposure',
    description: 'No hands-on exposure to operations-heavy work (logistics or adjacent). Knowledge of the domain comes from a desk: dashboards, APIs, sales decks or remote interviews. Present in all three Meets/Below hires (Vikram Nair, Rahul Bose, Preetham Rao) and absent from all five Exceeds hires.',
  },
  STRUCTURE_DEPENDENCY_RISK: {
    points: 30,
    label: 'Structure dependency',
    description: 'Career entirely inside large or heavily layered organisations (big teams, PM/CTO/VP layers, committees, handbooks) with no evidence of operating where the rules weren\'t written yet (calibrated to Preetham Rao, Below, and Vikram Nair, Meets).',
  },
  INFORMATION_GAP_RISK: {
    points: 20,
    label: 'Information gap',
    description: 'The CV lacks concrete outcomes or clear personal ownership: claims rest on team results, frameworks, certifications or titles rather than things the candidate did and what changed.',
  },
};

const RISK_KEYS = Object.keys(RISKS);

const THRESHOLDS = {
  HIGH_MIN_MATCH: 85,
  HIGH_MAX_RISK: 20,
  MEDIUM_MIN_MATCH: 65,
  MEDIUM_MAX_RISK: 50,
};

const hireLine = h => `- ${h.name}, hired as ${h.role}, last rated ${h.rating}: ${h.evidence}`;

const CALIBRATION = `Kargo's core principle: "The system recommends. Arjun decides. That decision is the last thing he touches."

Arjun's eight past hires did not match the job spec especially well. They share something the spec never asked for, and the shortlist must look like his BEST hires (still at Kargo and thriving), not like the spec. Most of these hires were not PMs, so calibrate on the pattern, not on job titles.

THE PATTERN (present in every Exceeds hire, absent from every Meets/Below hire):
1. Ground-level operations: they did the operational work in freight or logistics (documentation, customs, port, carrier or warehouse operations) before or alongside their role, rather than learning the domain from a desk.
2. Unforced adoption: they built something nobody asked for that others adopted on their own.
3. Ownership without structure: they owned outcomes end to end with no layer above, including when things broke.

What did NOT predict success: polished credentials and frameworks (Vikram Nair), autonomy and metrics without domain grounding (Rahul Bose), and technical integration depth without operational exposure (Preetham Rao).

EXCEEDS EXPECTATIONS (the pattern to match):
${HISTORICAL_HIRES.filter(h => h.fit === 'top').map(hireLine).join('\n')}

MEETS OR BELOW EXPECTATIONS (the pattern that predicts a merely adequate or poor hire):
${HISTORICAL_HIRES.filter(h => h.fit === 'misfit').map(hireLine).join('\n')}

Credentials, certifications, degrees and employer brand are not evidence either way. Score what the candidate did.`;

function getRole(roleCode) {
  const role = ROLES[roleCode];
  if (!role) throw new Error(`Unknown role "${roleCode}". Use PM or SPM.`);
  return role;
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(5, Math.max(1, v));
}

// Match_Score = SUM((score / 5) * weight) * 100, rounded to one decimal.
function computeMatchScore(roleCode, parameterScores) {
  const role = getRole(roleCode);
  const total = role.parameters.reduce((sum, p) => {
    const entry = parameterScores[p.key];
    if (!entry) throw new Error(`Missing score for ${p.key}`);
    return sum + (clampScore(entry.score) / 5) * p.weight;
  }, 0);
  return Math.round(total * 1000) / 10;
}

// Total_Risk_Score = MIN(100, SUM(points of distinct active flags)).
function computeRiskScore(activeFlags) {
  const unique = [...new Set(activeFlags.map(f => (typeof f === 'string' ? f : f.flag)))];
  const sum = unique.reduce((s, key) => s + (RISKS[key] ? RISKS[key].points : 0), 0);
  return Math.min(100, sum);
}

// Routing matrix. The rubric leaves one gap: match >= 85 with risk 21-50 is
// neither HIGH (risk too high) nor LOW. It's routed to MEDIUM so Arjun still
// sees a strong-match candidate, with the risk probes front and centre.
function categorize(matchScore, riskScore) {
  if (matchScore < THRESHOLDS.MEDIUM_MIN_MATCH || riskScore > THRESHOLDS.MEDIUM_MAX_RISK) {
    return 'LOW_POTENTIAL';
  }
  if (matchScore >= THRESHOLDS.HIGH_MIN_MATCH && riskScore <= THRESHOLDS.HIGH_MAX_RISK) {
    return 'HIGH_POTENTIAL';
  }
  return 'MEDIUM_POTENTIAL';
}

// Risk flags that follow mechanically from the extraction booleans. These are
// unioned with the flags the evaluator raises so a flag can't be dropped silently.
function deriveRiskFlagsFromExtraction(extraction) {
  const flags = [];
  const ops = extraction.operations_signals || {};
  const org = extraction.organisation_signals || {};
  const gaps = extraction.extracted_gaps_and_risks || {};

  if (ops.has_hands_on_operations_experience === false && ops.has_worked_alongside_operations_teams === false) {
    flags.push({ flag: 'NO_OPERATIONS_EXPOSURE_RISK', evidence: 'Extraction: no hands-on operations experience and no time working alongside operations teams.' });
  }
  if (org.only_large_or_layered_organisations && !org.has_early_stage_experience) {
    flags.push({ flag: 'STRUCTURE_DEPENDENCY_RISK', evidence: 'Extraction: career only in large or layered organisations, no early-stage experience.' });
  }
  if (gaps.missing_impact_metrics && gaps.vague_ownership_descriptions) {
    flags.push({ flag: 'INFORMATION_GAP_RISK', evidence: 'Extraction: no concrete outcomes and vague personal ownership.' });
  }
  for (const f of gaps.detected_risk_flags || []) {
    if (RISKS[f] && !flags.some(x => x.flag === f)) {
      flags.push({ flag: f, evidence: 'Flagged during CV extraction.' });
    }
  }
  return flags;
}

function mergeRiskFlags(evaluatorFlags, derivedFlags) {
  const byKey = new Map();
  for (const f of [...evaluatorFlags, ...derivedFlags]) {
    if (!RISKS[f.flag]) continue;
    if (!byKey.has(f.flag)) {
      byKey.set(f.flag, { flag: f.flag, points: RISKS[f.flag].points, evidence: f.evidence });
    }
  }
  return [...byKey.values()];
}

module.exports = {
  RUBRIC_VERSION,
  ROLES,
  RISKS,
  RISK_KEYS,
  THRESHOLDS,
  HISTORICAL_HIRES,
  CALIBRATION,
  getRole,
  clampScore,
  computeMatchScore,
  computeRiskScore,
  categorize,
  deriveRiskFlagsFromExtraction,
  mergeRiskFlags,
};

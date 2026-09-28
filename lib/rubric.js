// Calibrated rubrics, risk points and routing rules for Kargo PM / SPM hiring,
// transcribed from Kargo's standardized evaluation rubric. Everything numeric
// lives here in plain code: the LLM only scores each parameter 1-5 against the
// level descriptors and names risk flags; the weighted match score, risk total
// and category are computed deterministically so they're auditable.

const ROLES = {
  SPM: {
    label: 'Senior Product Manager',
    focus: 'Integration & data layer, platform architecture, reliability/data standards, shaping the PM function.',
    target_experience: '5–8 years PM experience (owning products without senior oversight).',
    parameters: [
      {
        key: 'p1_technical_integration',
        name: 'Integration Architecture & Technical Depth',
        weight: 0.30,
        calibration: 'Rohan Desai (5/5) vs. Vikram Nair (2/5)',
        levels: {
          low: 'Managed front-end/B2C features; lacks backend API, webhooks, or system integration understanding.',
          mid: 'Managed standard SaaS integrations in structured environments using pre-built APIs and vendor tools.',
          high: 'Proven track record of building carrier/WMS/ERP integration layers from scratch; clear build vs. configure vs. bypass decision frameworks. Unblocked enterprise deals via system interconnectivity.',
        },
      },
      {
        key: 'p2_domain_depth',
        name: 'Domain Depth & Operational Realities',
        weight: 0.25,
        calibration: 'Rahul Bose (5/5) & Preetham Rao (4.5/5)',
        levels: {
          low: 'Pure consumer or general B2C SaaS background without physical supply chain/operational complexity.',
          mid: 'General B2B SaaS background without supply chain, freight, or logistics exposure.',
          high: 'Deep operational fluency in freight forwarding, 3PL workflows, port portals, EDI/carrier APIs, and fleet management.',
        },
      },
      {
        key: 'p3_autonomous_scrappiness',
        name: 'Autonomous Execution in Early-Stage Ambiguity',
        weight: 0.25,
        calibration: 'Vikram Nair (2/5, failed due to enterprise dependence)',
        levels: {
          low: 'Requires large cross-functional teams, PMMs, dedicated analysts, and formal committee approvals.',
          mid: 'Comfortable operating in mid-stage companies with established PM handbooks and existing processes.',
          high: 'Thrives in Series A / 0-to-1 environments where "rules aren\'t written yet." Makes high-consequence platform calls independently and takes full accountability.',
        },
      },
      {
        key: 'p4_cross_functional_alignment',
        name: 'Cross-Functional Alignment & Deal Unblocking',
        weight: 0.20,
        calibration: 'Preetham Rao (4.5/5, unblocked enterprise sales)',
        levels: {
          low: 'Roadmap changes frequently based on ad-hoc requests or causes friction with engineering.',
          mid: 'Maintains standard sprint cadences and basic cross-team visibility across sales and engineering.',
          high: 'Creates unshakeable roadmaps trusted by Sales, Eng, and Founder. Directly unblocks enterprise revenue via platform capabilities without creating tech debt.',
        },
      },
    ],
  },
  PM: {
    label: 'Product Manager',
    focus: 'Core operations platform (tracking, docs, status visibility), customer discovery, sprint execution.',
    target_experience: '2–4 years PM experience (building rather than maintaining).',
    parameters: [
      {
        key: 'p1_customer_discovery',
        name: 'Ground-Level Customer Discovery & Empathy',
        weight: 0.30,
        calibration: 'Sunita K. (5/5) vs. Lavanya Iyer (2/5)',
        levels: {
          low: 'Relies solely on surveys, analytics, remote interviews, or polished B2C user research methods.',
          mid: 'Conducts standard user interviews and converts customer feedback into clear user stories and specs.',
          high: 'Spent direct time on ground level in operational settings (dispatch rooms, freight yards, warehouses). Expert at replacing spreadsheet/WhatsApp chaos with structured software.',
        },
      },
      {
        key: 'p2_scrappiness_velocity',
        name: '0-to-1 Scrappiness & Shipping Velocity',
        weight: 0.30,
        calibration: 'Aditya Shetty (4.5/5)',
        levels: {
          low: 'Dependent on pre-existing design systems, PM handbooks, and large cross-functional team structures.',
          mid: 'Operates well in moderately structured startups with standard bi-weekly sprint rhythms.',
          high: 'Operates autonomously without structure; builds own workflows and ships/kills features quickly in short, rapid cycles based on actual usage.',
        },
      },
      {
        key: 'p3_engineering_alignment',
        name: 'Engineering Alignment & Sprint Execution',
        weight: 0.20,
        calibration: 'Aditya Shetty & Meghna Tiwari',
        levels: {
          low: 'Vague specifications leading to constant sprint ambiguity, scope creep, and engineering friction.',
          mid: 'Prepares detailed stories; keeps engineering clear 1 sprint ahead.',
          high: 'Engineering knows what they are building 3+ sprints out; builds deep technical trust with development teams without micromanagement.',
        },
      },
      {
        key: 'p4_metric_driven_adoption',
        name: 'Metric-Driven Unforced Feature Adoption',
        weight: 0.20,
        calibration: 'Meghna Tiwari (4/5) & Sunita K. (5/5)',
        levels: {
          low: 'Tracks vanity metrics (logins, pageviews) without operational impact focus.',
          mid: 'Tracks feature adoption rates and retention metrics post-launch.',
          high: 'Proves shipped features drive organic, unforced adoption that measurably reduces operational turnarounds and drop-off rates.',
        },
      },
    ],
  },
};

const RISKS = {
  ENTERPRISE_DEPENDENCY_RISK: {
    points: 35,
    label: 'Enterprise Dependency',
    description: 'Worked exclusively in large corporates/public companies without Series A / 0-1 scrappiness (calibrated to Vikram Nair).',
  },
  DOMAIN_MISALIGNMENT_RISK: {
    points: 30,
    label: 'Domain Misalignment / B2C',
    description: 'B2C consumer app background, or surface-level B2B experience lacking operational/supply chain depth (calibrated to Lavanya Iyer).',
  },
  INFORMATION_GAP_RISK: {
    points: 20,
    label: 'Information Gap',
    description: 'Lack of explicit metrics, impact outcomes, or clear scope of ownership in the CV.',
  },
};

const RISK_KEYS = Object.keys(RISKS);

const THRESHOLDS = {
  HIGH_MIN_MATCH: 85,
  HIGH_MAX_RISK: 20,
  MEDIUM_MIN_MATCH: 65,
  MEDIUM_MAX_RISK: 50,
};

// Kargo's 8 historical product hires and the lesson each one teaches.
const HISTORICAL_HIRES = [
  { name: 'Rohan Desai', rating: 5, fit: 'top', lesson: 'Direct mid-mile / carrier API depth and a clear build/configure philosophy.' },
  { name: 'Sunita K.', rating: 5, fit: 'top', lesson: 'In-person, ground-level operational discovery beats remote interviews.' },
  { name: 'Rahul Bose', rating: 5, fit: 'top', lesson: 'Ground-level operational domain knowledge drastically reduces onboarding time.' },
  { name: 'Aditya Shetty', rating: 4.5, fit: 'top', lesson: 'High shipping velocity and self-sufficiency in 0-to-1 environments.' },
  { name: 'Preetham Rao', rating: 4.5, fit: 'top', lesson: 'Bridges technical integrations with enterprise sales unblocking.' },
  { name: 'Meghna Tiwari', rating: 4, fit: 'top', lesson: 'Metric-driven focus on core operational SLAs predicts steady output.' },
  { name: 'Vikram Nair', rating: 2, fit: 'misfit', lesson: 'Large enterprise pedigree (ex-Oracle/SAP) without 0-to-1 scrappiness is a NEGATIVE signal.' },
  { name: 'Lavanya Iyer', rating: 2, fit: 'misfit', lesson: 'B2C/consumer app background lacks resilience for messy B2B logistics workflows.' },
];

const hireLine = h => `- ${h.name} (${h.rating}/5): ${h.lesson}`;

const CALIBRATION = `Kargo's core principle: "AI finds the signal. Arjun makes the decision. Automation handles everything after."

Kargo has made 8 historical product hires. Calibrate against them, NOT against a generic job spec. Kargo's successful hires match patterns the spec doesn't capture.

TOP PERFORMERS (the pattern to match; High Potential candidates resemble Rohan Desai, Rahul Bose, Sunita K., Aditya Shetty):
${HISTORICAL_HIRES.filter(h => h.fit === 'top').map(hireLine).join('\n')}

MISFITS (the pattern that predicts failure; Low Potential candidates resemble these):
${HISTORICAL_HIRES.filter(h => h.fit === 'misfit').map(hireLine).join('\n')}`;

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
  const ped = extraction.pedigree_classification || {};
  const exec = extraction.execution_and_scrappiness_signals || {};
  const gaps = extraction.extracted_gaps_and_risks || {};

  if (ped.has_enterprise_only_background && !ped.has_early_stage_0_to_1) {
    flags.push({ flag: 'ENTERPRISE_DEPENDENCY_RISK', evidence: 'Extraction: enterprise-only background with no early-stage 0-to-1 experience.' });
  }
  if (exec.b2c_consumer_focus_only) {
    flags.push({ flag: 'DOMAIN_MISALIGNMENT_RISK', evidence: 'Extraction: B2C consumer focus only.' });
  }
  if (gaps.missing_impact_metrics) {
    flags.push({ flag: 'INFORMATION_GAP_RISK', evidence: 'Extraction: CV is missing explicit impact metrics.' });
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

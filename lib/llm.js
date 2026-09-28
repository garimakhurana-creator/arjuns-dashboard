// The three AI steps of the pipeline: extract signals from a redacted CV,
// score it against the calibrated rubric, then write the interview brief and
// email copy for the category the backend assigned. Every call uses
// structured JSON output validated against a zod schema, so the backend
// always gets schema-valid data back. Runs on Gemini when GEMINI_API_KEY is
// set (or LLM_PROVIDER=gemini), otherwise on Claude.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { getRole, RISKS, RISK_KEYS, CALIBRATION } = require('./rubric');

const GEMINI_TIMEOUT_MS = 5 * 60 * 1000;
const GEMINI_ATTEMPTS = 4; // waits 5s, 15s, 45s between tries
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function provider() {
  const explicit = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (explicit === 'gemini' || explicit === 'anthropic') return explicit;
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'gemini' : 'anthropic';
}

function activeModel() {
  return provider() === 'gemini'
    ? process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
    : process.env.CLAUDE_MODEL || 'claude-opus-5';
}

function isConfigured() {
  return provider() === 'gemini'
    ? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
    : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const RiskFlag = z.enum(RISK_KEYS);

// Shape mirrors Kargo's candidate-extraction format. There is no name/contact
// field on purpose: the model only ever sees redacted text.
// Signals the calibrated rubric scores on. There is no name/contact field on
// purpose: the model only ever sees redacted text.
const ExtractionSchema = z.object({
  profile: z.object({
    target_role: z.string(),
    total_years_experience: z.number(),
    total_pm_experience: z.number(),
    current_company: z.string(),
    current_title: z.string(),
  }),
  operations_signals: z.object({
    has_hands_on_operations_experience: z.boolean().describe('Did the operational work themselves (documentation, customs, dispatch, carrier coordination, port/terminal/warehouse ops, supply-chain planning).'),
    operations_domain: z.enum(['FREIGHT_LOGISTICS', 'ADJACENT_OPERATIONS', 'NONE']),
    has_worked_alongside_operations_teams: z.boolean().describe('Sustained, in-person time with operations users (on site, in the room), not only calls or surveys.'),
    raw_operations_evidence: z.array(z.string()),
  }),
  building_signals: z.object({
    self_initiated_builds: z.array(z.string()).describe('Things they built or started without being asked, with who adopted them.'),
    shipped_and_killed: z.array(z.string()).describe('Features shipped and features deliberately killed, with the reason.'),
    unforced_adoption_evidence: z.array(z.string()).describe('Evidence that users or colleagues chose to adopt their work, with numbers where given.'),
  }),
  integration_signals: z.object({
    owned_integration_or_data_layer: z.boolean(),
    build_configure_avoid_decisions: z.array(z.string()),
    reliability_or_data_quality_ownership: z.array(z.string()),
    raw_integration_evidence: z.array(z.string()),
  }),
  organisation_signals: z.object({
    has_early_stage_experience: z.boolean().describe('Seed/Series A, first hire in a function, or founding team.'),
    only_large_or_layered_organisations: z.boolean().describe('Every role was in a large company or under layers of senior managers, committees or established PM teams.'),
    owned_without_layer_above: z.array(z.string()).describe('Evidence they were the most senior decision-maker for their area.'),
    raw_cross_functional_evidence: z.array(z.string()),
  }),
  extracted_gaps_and_risks: z.object({
    missing_impact_metrics: z.boolean(),
    vague_ownership_descriptions: z.boolean(),
    detected_risk_flags: z.array(RiskFlag),
  }),
});

function evaluationSchema(roleCode) {
  const role = getRole(roleCode);
  const paramShape = {};
  for (const p of role.parameters) {
    paramShape[p.key] = z.object({
      score: z.number().int().describe('1-5'),
      evidence: z.string().describe('Specific CV evidence (quote or close paraphrase) justifying the score. If absent, say what is missing.'),
    });
  }
  return z.object({
    parameter_scores: z.object(paramShape),
    active_risk_flags: z.array(z.object({ flag: RiskFlag, evidence: z.string() })),
    closest_historical_match: z.string().describe('The single historical hire this candidate most resembles, formatted "Name (top performer)" or "Name (misfit)", or "None" if no clear resemblance.'),
    recommendation_reason: z.string(),
    full_evaluation_rationale: z.string(),
  });
}

const EmailSchema = z.object({
  type: z.enum(['INTERVIEW_INVITE', 'DELAYED_REJECTION']),
  subject: z.string(),
  body_text: z.string(),
});

const DeliverablesSchema = z.object({
  interview_brief: z.object({
    summary: z.string(),
    why_ranked_here: z.string(),
    key_strengths: z.array(z.string()),
    risk_factors: z.array(z.string()),
    interview_probes: z.array(z.string()).describe('Exactly 3 probes'),
  }),
  resend_email_draft: EmailSchema,
  fallback_rejection_draft: EmailSchema.nullable(),
});

function rubricText(roleCode) {
  const role = getRole(roleCode);
  const params = role.parameters
    .map(p => `${p.key}: ${p.name} (${Math.round(p.weight * 100)}% weight; calibrated on ${p.calibration})
  Why it matters: ${p.source}
  1–2 pts: ${p.levels.low}
  3 pts:   ${p.levels.mid}
  4–5 pts: ${p.levels.high}`)
    .join('\n\n');
  const risks = Object.entries(RISKS)
    .map(([k, r]) => `- ${k} (${r.points} pts): ${r.description}`)
    .join('\n');
  return `ROLE: ${role.label}
Role focus: ${role.focus}
Target experience: ${role.target_experience}

PARAMETERS (score each 1-5 using the level descriptors):
${params}

RISK FLAGS:
${risks}`;
}

const SCORE_SCALE = `Scoring: place the candidate in the level whose descriptor the CV evidence supports, then pick within it. In the 1–2 band, use 1 when there's no relevant evidence and 2 when there's weak evidence. In the 4–5 band, use 5 only when the evidence clearly matches the named Exceeds-hire calibration. Score only what the CV shows; never infer strengths that aren't written down. Target experience is context for the brief, not an automatic penalty.`;

const SYSTEM_BASE = `You are the evaluation engine inside Kargo's hiring system. Kargo is a Series A logistics SaaS company in Mumbai. The founder, Arjun Mehta, has no HR team and relies on your output to decide who to interview.

${CALIBRATION}

Candidate text has been redacted: [CANDIDATE], [EMAIL], [PHONE] and [URL] replace personal details. Never guess at or reconstruct them, and never let gender, age, name, college prestige or other protected attributes affect a judgement.`;

function callStructured(opts) {
  return provider() === 'gemini' ? callGemini(opts) : callClaude(opts);
}

async function callClaude({ system, user, schema, effort }) {
  const response = await getClient().messages.parse({
    model: activeModel(),
    max_tokens: 16000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: zodOutputFormat(schema), ...(effort ? { effort } : {}) },
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to evaluate this CV.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Model output was truncated (max_tokens).');
  }
  if (!response.parsed_output) {
    throw new Error('Model returned output that did not match the schema.');
  }
  return response.parsed_output;
}

// zod -> JSON Schema, minus the keys Gemini's responseJsonSchema doesn't need
// (the $schema URI and zod's safe-integer bounds on .int()).
function geminiSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  return JSON.parse(JSON.stringify(json), (key, value) =>
    (key === 'minimum' || key === 'maximum') && Math.abs(value) === Number.MAX_SAFE_INTEGER ? undefined : value);
}

async function callGemini({ system, user, schema, effort }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel())}:generateContent`;
  const generationConfig = {
    maxOutputTokens: 16000,
    responseMimeType: 'application/json',
    responseJsonSchema: geminiSchema(schema),
  };
  if (effort === 'low' || effort === 'medium') generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  });

  // Retry dropped connections, rate limits and Gemini 5xx with backoff.
  let res, data;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= GEMINI_ATTEMPTS) break;
    } catch (err) {
      if (attempt >= GEMINI_ATTEMPTS || err.name === 'TimeoutError') throw new Error(`Gemini request failed: ${err.cause?.code || err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000 * 3 ** (attempt - 1)));
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || 'request failed'}`);

  const candidate = (data.candidates || [])[0];
  if (!candidate) {
    throw new Error(`Gemini returned no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}.`);
  }
  if (candidate.finishReason === 'MAX_TOKENS') throw new Error('Model output was truncated (max tokens).');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini stopped early: ${candidate.finishReason}.`);
  }

  const text = (candidate.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned invalid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Gemini output did not match the schema: ${result.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return result.data;
}

async function extractSignals(redactedCv, roleCode) {
  return callStructured({
    system: SYSTEM_BASE,
    effort: 'medium',
    schema: ExtractionSchema,
    user: `Extract structured hiring signals from this redacted CV. The candidate applied for: ${getRole(roleCode).label}.

Rules:
- Evidence arrays hold short, near-verbatim CV lines. Empty array if none.
- Booleans are true only when the CV states it explicitly.
- Hands-on operations means the candidate did the operational work. Selling to, building software for, or integrating APIs with logistics companies does not count as hands-on (it may count as working alongside ops teams if they were physically with them).
- detected_risk_flags: ${RISK_KEYS.join(', ')}. Raise INFORMATION_GAP_RISK only if the CV genuinely lacks concrete outcomes or clear personal ownership.

<cv>
${redactedCv}
</cv>`,
  });
}

async function evaluateCandidate(redactedCv, extraction, roleCode) {
  return callStructured({
    system: SYSTEM_BASE,
    schema: evaluationSchema(roleCode),
    user: `Evaluate this candidate against Kargo's calibrated rubric.

${rubricText(roleCode)}

${SCORE_SCALE}

For active_risk_flags, include only flags you can justify with evidence (or a clearly stated absence of it). The backend computes the weighted match score, risk total and category from your scores. Do not compute them yourself.

full_evaluation_rationale: a thorough audit paragraph covering every parameter and flag. It is stored permanently, even if the candidate is auto-rejected.

<extracted_signals>
${JSON.stringify(extraction, null, 2)}
</extracted_signals>

<cv>
${redactedCv}
</cv>`,
  });
}

async function generateDeliverables({ roleCode, category, matchScore, riskScore, evaluation, extraction }) {
  const role = getRole(roleCode);
  const surfaced = category !== 'LOW_POTENTIAL';
  const emailInstructions = surfaced
    ? `resend_email_draft: type INTERVIEW_INVITE. It comes from Arjun personally: warm, specific to one or two real things in the candidate's background, under 150 words. It invites them to a 45-minute conversation and includes the literal placeholder [Calendly Link] for booking. Address them as [Candidate Name]. Sign off as "Arjun Mehta, Founder, Kargo".${category === 'MEDIUM_POTENTIAL' ? ' Keep the tone exploratory ("I\'d like to learn more about…").' : ''}
fallback_rejection_draft: type DELAYED_REJECTION, used only if Arjun passes after reviewing. It follows the rejection rules below.`
    : `resend_email_draft: type DELAYED_REJECTION. fallback_rejection_draft: null.`;

  return callStructured({
    system: SYSTEM_BASE,
    schema: DeliverablesSchema,
    user: `The backend has categorised this ${role.label} candidate as ${category} (match ${matchScore}%, risk ${riskScore}/100).

Write:
1. interview_brief for Arjun: a 2-sentence summary, why_ranked_here (the core value proposition, referencing the closest historical hire when there is one), key_strengths, risk_factors (for MEDIUM, name the specific missing evidence), and EXACTLY 3 interview_probes. Probes must be pointed, specific to this CV, and designed to confirm or disprove the weakest-evidence parameters and any active risk flags (for example: what they actually did inside operations and what it taught them, something they built that nobody asked for, a feature they killed and why, a call they made alone that went wrong).${category === 'MEDIUM_POTENTIAL' ? ' At least one probe must test whether they can operate with no structure at a Series A, and one whether they would get into the room with freight operations teams rather than learn the domain from a desk.' : ''}
2. ${emailInstructions}

Rejection rules: respectful, human, under 110 words, no scores or internal reasoning, no false promises. Thank them for their time and wish them well. Address them as [Candidate Name] and sign off as "Arjun Mehta, Founder, Kargo".

<evaluation>
${JSON.stringify(evaluation, null, 2)}
</evaluation>

<extracted_signals>
${JSON.stringify(extraction, null, 2)}
</extracted_signals>`,
  });
}

module.exports = { activeModel, isConfigured, provider, extractSignals, evaluateCandidate, generateDeliverables };

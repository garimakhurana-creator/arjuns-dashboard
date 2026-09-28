# Kargo Hiring

Hiring automation for Kargo's PM and Senior PM roles. It scores CVs against a rubric calibrated on Kargo's 8 historical hires, routes candidates, and sends emails through Resend.

> AI finds the signal. Arjun makes the decision. Automation handles everything after.

## Pipeline

1. **Redact.** Name, email, phone and URLs are stripped before any text reaches the LLM (`lib/pii.js`).
2. **Extract.** The LLM pulls structured hiring signals from the redacted CV.
3. **Score.** The LLM rates the 4 role parameters 1–5 against the level descriptors, citing evidence, and raises risk flags. Weights, risk points and routing are computed in plain code (`lib/rubric.js`).
4. **Route.**
   - **High** (match ≥ 85%, risk ≤ 20) goes to the Shortlist tab with the full brief and invite draft.
   - **Medium** (65–84%, risk ≤ 50) goes to the Review queue as a one-line row with Invite and Reject.
   - **Low** (< 65% or risk > 50) is auto-rejected. The rejection email is scheduled right away, to arrive after `REJECTION_DELAY_HOURS`.
   - Match ≥ 85% with risk 21–50 goes to Medium.
5. **Audit.** Every candidate is stored with the full rationale, including auto-rejected ones.

## Setup

```bash
npm install
cp .env.example .env   # fill in keys
npm start              # http://localhost:3500
```

- **LLM:** Gemini when `GEMINI_API_KEY` is set, otherwise Claude (`ANTHROPIC_API_KEY`). Set `LLM_PROVIDER` to force one.
- **Email:** `RESEND_API_KEY`, plus `RESEND_FROM` on a domain verified in Resend.
- **Storage:** Neon Postgres when `DATABASE_URL` is set; the `kargo_candidates` table (`db/schema.sql`) is created on first run. Otherwise candidates go to `data/candidates.json`.
- **Demo data:** `npm run seed` loads 3 demo candidates. `npm test` runs the scoring and PII tests.

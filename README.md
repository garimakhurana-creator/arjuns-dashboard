# Arjun's Dashboard

Kargo's hiring desk for the Product Manager and Senior Product Manager roles. It scores CVs against a rubric calibrated on Kargo's 8 past hires, builds a shortlist Arjun can trust, and handles the emails that follow his decision.

> The system recommends. Arjun decides. That decision is the last thing he touches.

**Live:** https://kargo-hiring-sand.vercel.app

## Using the dashboard

- **Shortlist:** High-potential candidates, plus Medium ones Arjun chose to reconsider. Each card has a match-score ring, rubric evidence, risk flags, an interview brief with three questions to probe, and a preview of the invite. A minimum-match slider filters the list.
- **Review queue:**
  - **Medium potential:** one-line rows with *Open detailed summary*, *Send rejection mail* and *Reconsider* (moves them to the Shortlist).
  - **Rejection emails:** every rejection, with its status (*Not sent*, *Scheduled · arrives …*, *Sent*) and a *Send rejection mail* button.
  - Both sections open and close, and Medium has its own match filter.
- **Audit log:** every evaluated candidate, including auto-rejected ones, with full scoring evidence and reasoning.
- **Emails:** every invite and rejection opens in an editor first (From, To, Subject, Message). *Save draft* keeps edits; *Send* saves and sends. Invites send immediately; rejections arrive `REJECTION_DELAY_HOURS` (default 48) later.

## Rubric (`lib/rubric.js`)

Built from the case problem statement (hire ratings), the 8 past-hire CVs and the two job descriptions. The JD describes the role; the hires show who succeeds. Every Exceeds hire did hands-on work in freight or logistics operations, built something others adopted without being asked, and owned outcomes with no layer above them. Every Meets/Below hire lacked the first of these.

| PM | Weight | SPM | Weight |
|---|---|---|---|
| Ground-level operations immersion | 30% | Integration & platform judgment | 30% |
| Ship, learn & kill in short cycles | 25% | Ground-level operations depth | 30% |
| Unforced adoption with operational impact | 25% | Autonomous calls in ambiguity | 25% |
| Engineering trust & self-built rhythm | 20% | Cross-functional unblocking & standards | 15% |

Risk flags: no operations exposure (30), structure dependency (30), information gap (20).

Each evaluation is stamped with `RUBRIC_VERSION`. After a rubric change, older records stay in the audit log but leave the shortlist and review queue, and the importer re-scores them. `npm run calibrate -- <hires-folder>` scores the past-hire CVs and checks that Exceeds hires outrank Meets/Below.

## Pipeline

1. **Read and redact.** PDF, Word or text. Name, email, phone and URLs are stripped before any text reaches the LLM (`lib/pii.js`).
2. **Extract.** The LLM pulls structured hiring signals from the redacted CV.
3. **Score.** The LLM rates the 4 role parameters 1–5 against the level descriptors, citing evidence, and raises risk flags. Weights, risk points and routing are computed in plain code (`lib/rubric.js`).
4. **Route.**
   - **High** (match ≥ 85%, risk ≤ 20) goes to the Shortlist.
   - **Medium** (65–84%, risk ≤ 50) goes to the Review queue. Match ≥ 85% with risk 21–50 also goes here.
   - **Low** (< 65% or risk > 50) is auto-rejected, and its rejection email is scheduled straight away.
5. **Audit.** Every candidate is stored with the full rationale.

## Setup

```bash
npm install
cp .env.example .env   # fill in keys
npm start              # http://localhost:3500
```

| Setting | What it does |
|---|---|
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | LLM for scoring. Gemini is used when its key is set; `LLM_PROVIDER` forces one. |
| `DATABASE_URL` | Neon Postgres. The `kargo_candidates` table (`db/schema.sql`) is created on first run. Without it, candidates go to `data/candidates.json`. |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO` | Email through Resend. `RESEND_FROM` must be on a domain verified in Resend (or `onboarding@resend.dev` for testing). |
| `EMAIL_OVERRIDE_TO` | **Test mode.** Every email goes to this address instead of the candidate, with a note saying who it was meant for. Remove it to email candidates for real. |
| `CALENDLY_URL` | Booking link placed in interview invites. |
| `REJECTION_DELAY_HOURS` | Delay before rejection emails arrive (default 48). |
| `DASHBOARD_PASSWORD` | Password for the whole app (browser login box; any username). Required on Vercel unless `DASHBOARD_PUBLIC=true`. |
| `DASHBOARD_PUBLIC` | Set to `true` to open the dashboard without a login. |

### Scripts

- `npm test`: scoring, routing, PII redaction, email test mode and animation tests.
- `npm run evaluate -- <folder>`: bulk-score a folder of CVs (`pm_*` → PM, `spm_*` → SPM, others under both rubrics). Add `--send` to schedule Low rejections.
- `npm run calibrate -- <hires-folder>`: check the rubric against the past-hire CVs.
- `npm run seed`: load 3 demo candidates into the local file store.

## Deploying

The Vercel project is connected to this repository: **every push to `main` deploys to production**, and other branches and pull requests get preview links. Settings live in Vercel → Project → Settings → Environment Variables (same names as the table above).

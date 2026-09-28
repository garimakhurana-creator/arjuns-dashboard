-- Kargo hiring: candidate evaluations and audit log (Neon / Postgres).
-- Applied automatically on server start (lib/store.js). Safe to re-run.

create table if not exists kargo_candidates (
  candidate_id      text primary key,
  candidate_name    text not null,
  role_code         text not null check (role_code in ('PM', 'SPM')),
  category          text not null check (category in ('HIGH_POTENTIAL', 'MEDIUM_POTENTIAL', 'LOW_POTENTIAL')),
  match_score_pct   numeric(5, 1) not null,
  total_risk_score  integer not null,
  status            text not null,
  email_status      text not null,
  evaluated_at      timestamptz not null,
  record            jsonb not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists kargo_candidates_category_idx on kargo_candidates (category);
create index if not exists kargo_candidates_email_status_idx on kargo_candidates (email_status);

-- Kargo hiring: candidate evaluations and audit log.
-- Run once in the Supabase SQL editor for the project in SUPABASE_URL.

create table if not exists public.kargo_candidates (
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

create index if not exists kargo_candidates_category_idx on public.kargo_candidates (category);
create index if not exists kargo_candidates_email_status_idx on public.kargo_candidates (email_status);

-- Candidate CV data is personal information. RLS on with no policies means
-- only the server's service-role key can read or write; the anon key cannot.
alter table public.kargo_candidates enable row level security;

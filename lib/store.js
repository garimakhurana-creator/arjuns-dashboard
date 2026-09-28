// Candidate store. Every evaluated candidate is written here, including
// auto-rejected ones, so it doubles as the audit log.
//
// Uses Supabase (table kargo_candidates, see supabase/schema.sql) when
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, otherwise a local JSON
// file at data/candidates.json. Both backends expose the same async API.

const fs = require('fs');
const path = require('path');

const TABLE = 'kargo_candidates';
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'candidates.json');

// Top-level columns mirrored from the record so rows are filterable in the
// Supabase dashboard; the full record lives in the `record` jsonb column.
function toRow(r) {
  return {
    candidate_id: r.candidate_id,
    candidate_name: r.candidate_name,
    role_code: r.role_code,
    category: r.categorization.category,
    match_score_pct: r.scoring.match_score_pct,
    total_risk_score: r.scoring.total_risk_score,
    status: r.status,
    email_status: r.email_status,
    evaluated_at: r.evaluation_timestamp,
    record: r,
  };
}

const localStore = {
  backend: 'local',
  async readAll() {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  },
  async writeAll(records) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, DB_PATH);
  },
  async candidateIds() {
    return (await this.readAll()).map(r => r.candidate_id);
  },
  async insert(record) {
    const all = await this.readAll();
    all.push(record);
    await this.writeAll(all);
    return record;
  },
  async get(id) {
    return (await this.readAll()).find(r => r.candidate_id === id) || null;
  },
  async update(id, mutate) {
    const all = await this.readAll();
    const rec = all.find(r => r.candidate_id === id);
    if (!rec) return null;
    mutate(rec);
    await this.writeAll(all);
    return rec;
  },
};

function supabaseStore(client) {
  const check = ({ data, error }) => {
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data;
  };
  return {
    backend: 'supabase',
    async readAll() {
      const rows = check(await client.from(TABLE).select('record').order('evaluated_at', { ascending: true }));
      return rows.map(r => r.record);
    },
    async candidateIds() {
      return check(await client.from(TABLE).select('candidate_id')).map(r => r.candidate_id);
    },
    async insert(record) {
      check(await client.from(TABLE).insert(toRow(record)));
      return record;
    },
    async get(id) {
      const row = check(await client.from(TABLE).select('record').eq('candidate_id', id).maybeSingle());
      return row ? row.record : null;
    },
    async update(id, mutate) {
      const rec = await this.get(id);
      if (!rec) return null;
      mutate(rec);
      check(await client.from(TABLE).update({ ...toRow(rec), updated_at: new Date().toISOString() }).eq('candidate_id', id));
      return rec;
    },
  };
}

let cached = null;
function backend() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const { createClient } = require('@supabase/supabase-js');
    cached = supabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  } else {
    cached = localStore;
  }
  return cached;
}

async function nextCandidateId(now = new Date()) {
  const prefix = `KARGO-${now.getUTCFullYear()}-`;
  const max = (await backend().candidateIds())
    .filter(id => id && id.startsWith(prefix))
    .reduce((m, id) => Math.max(m, Number(id.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

module.exports = {
  backendName: () => backend().backend,
  readAll: () => backend().readAll(),
  insert: record => backend().insert(record),
  get: id => backend().get(id),
  update: (id, mutate) => backend().update(id, mutate),
  nextCandidateId,
};

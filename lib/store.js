// Candidate store. Every evaluated candidate is written here, including
// auto-rejected ones, so it doubles as the audit log.
//
// Uses Postgres on Neon (table kargo_candidates, see db/schema.sql, applied on
// first use) when DATABASE_URL is set, otherwise a local JSON file at
// data/candidates.json. Both backends expose the same async API.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'candidates.json');

// Top-level columns mirrored from the record so rows are filterable in the
// Neon console; the full record lives in the `record` jsonb column.
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
  async close() {},
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

const COLUMNS = ['candidate_id', 'candidate_name', 'role_code', 'category', 'match_score_pct',
  'total_risk_score', 'status', 'email_status', 'evaluated_at', 'record'];

function postgresStore(connectionString, Pool = require('pg').Pool) {
  const pool = new Pool({ connectionString, max: 5, ssl: { rejectUnauthorized: true } });
  let ready = null;
  // Creates the table on first use so a fresh Neon database needs no manual step.
  const ensureSchema = () => (ready ||= pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8')).catch(err => {
    ready = null;
    throw err;
  }));
  const q = async (text, params) => {
    await ensureSchema();
    return pool.query(text, params);
  };
  const values = r => { const row = toRow(r); return COLUMNS.map(c => row[c]); };

  return {
    backend: 'neon',
    close: () => pool.end(),
    async readAll() {
      return (await q('select record from kargo_candidates order by evaluated_at, candidate_id')).rows.map(r => r.record);
    },
    async candidateIds() {
      return (await q('select candidate_id from kargo_candidates')).rows.map(r => r.candidate_id);
    },
    async insert(record) {
      await q(`insert into kargo_candidates (${COLUMNS.join(', ')}) values (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`, values(record));
      return record;
    },
    async get(id) {
      const { rows } = await q('select record from kargo_candidates where candidate_id = $1', [id]);
      return rows[0] ? rows[0].record : null;
    },
    // Read-modify-write under a row lock so concurrent clicks can't clobber each other.
    async update(id, mutate) {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select record from kargo_candidates where candidate_id = $1 for update', [id]);
        if (!rows[0]) {
          await client.query('rollback');
          return null;
        }
        const rec = rows[0].record;
        mutate(rec);
        const sets = COLUMNS.slice(1).map((c, i) => `${c} = $${i + 2}`).join(', ');
        await client.query(`update kargo_candidates set ${sets}, updated_at = now() where candidate_id = $1`, values(rec));
        await client.query('commit');
        return rec;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

let cached = null;
function backend() {
  if (cached) return cached;
  cached = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : localStore;
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
  close: () => (cached ? cached.close() : Promise.resolve()),
  _postgresStore: postgresStore, // exposed for tests
};

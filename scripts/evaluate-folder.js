// Bulk-evaluates a folder of CVs through the same pipeline as the web upload.
//
//   node scripts/evaluate-folder.js <folder> [--concurrency 3] [--send] [--allow-local] [--dry-run]
//
// Role comes from the filename: pm_* -> PM, spm_* -> SPM. Any other file is
// scored against BOTH rubrics (two records sharing an evaluation_group).
// For those pairs, a Low result's rejection is held back if the other role
// surfaced, and a candidate Low under both gets a single rejection, not two.
//
// Rejection emails are only sent with --send; otherwise Low rejections stay
// queued in the Review tab. Re-running skips files already evaluated.

require('../lib/env').loadDotEnv();

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { evaluateCv } = require('../lib/pipeline');
const { pdfToText } = require('../lib/pdf');
const { deliverEmail } = require('../lib/dispatch');

function parseArgs(argv) {
  const opts = { dir: null, concurrency: 3, send: false, allowLocal: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--send') opts.send = true;
    else if (a === '--allow-local') opts.allowLocal = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (!opts.dir) opts.dir = a;
  }
  return opts;
}

function rolesFor(file) {
  if (/^spm[_-]/i.test(file)) return { roles: ['SPM'], source: 'filename' };
  if (/^pm[_-]/i.test(file)) return { roles: ['PM'], source: 'filename' };
  return { roles: ['PM', 'SPM'], source: 'both_rubrics' };
}

async function readText(filePath) {
  if (/\.pdf$/i.test(filePath)) return pdfToText(fs.readFileSync(filePath));
  return fs.readFileSync(filePath, 'utf-8');
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Decides which Low rejections in a both-rubrics group should actually go out.
async function resolveGroups(groupKeys) {
  const all = await store.readAll();
  for (const key of groupKeys) {
    const members = all.filter(r => r.evaluation_group === key);
    const lows = members.filter(r => r.categorization.category === 'LOW_POTENTIAL');
    if (!lows.length) continue;
    const surfaced = members.some(r => r.categorization.surfaced_to_arjun_dashboard);
    const held = surfaced ? lows : lows.slice(1);
    const reason = surfaced
      ? 'Rejection held: candidate surfaced under the other role.'
      : 'Rejection held: duplicate of the other role\'s rejection (one email per candidate).';
    for (const r of held) {
      if (r.email_status !== 'QUEUED') continue;
      await store.update(r.candidate_id, x => {
        x.email_status = 'HELD';
        x.email_history.push({ type: 'DELAYED_REJECTION', held: true, note: reason, at: new Date().toISOString() });
      });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir || !fs.existsSync(opts.dir)) {
    console.error('Usage: node scripts/evaluate-folder.js <folder> [--concurrency 3] [--send] [--allow-local] [--dry-run]');
    process.exit(1);
  }
  if (!opts.dryRun && store.backendName() !== 'neon' && !opts.allowLocal) {
    console.error('DATABASE_URL is not set, so results would go to data/candidates.json. Set it in .env, or pass --allow-local.');
    process.exit(1);
  }

  const files = fs.readdirSync(opts.dir).filter(f => /\.(pdf|txt|md)$/i.test(f)).sort();
  const existing = await store.readAll();
  const done = new Set(existing.map(r => `${r.source_file}|${r.role_code}`));

  const jobs = [];
  for (const file of files) {
    const { roles, source } = rolesFor(file);
    for (const role of roles) {
      if (done.has(`${file}|${role}`)) continue;
      jobs.push({ file, role, source, group: source === 'both_rubrics' ? `GRP-${file.replace(/\.[^.]+$/, '')}` : null });
    }
  }

  console.log(`${files.length} files -> ${jobs.length} evaluations to run (storage: ${store.backendName()}, concurrency ${opts.concurrency})`);
  if (opts.dryRun) {
    for (const j of jobs) console.log(`  ${j.role.padEnd(3)} ${j.file}${j.group ? '  [both rubrics]' : ''}`);
    return;
  }

  // Reserve IDs up front so concurrent workers can't pick the same one.
  const firstId = await store.nextCandidateId();
  const [prefix, startNum] = [firstId.replace(/\d+$/, ''), Number(firstId.match(/(\d+)$/)[1])];
  jobs.forEach((j, i) => { j.candidateId = `${prefix}${String(startNum + i).padStart(3, '0')}`; });

  const results = [];
  const started = Date.now();
  await runPool(jobs, opts.concurrency, async job => {
    const t = Date.now();
    try {
      const rawText = await readText(path.join(opts.dir, job.file));
      const record = await evaluateCv({
        rawText,
        roleCode: job.role,
        overrides: { filename: job.file },
        candidateId: job.candidateId,
        calendlyUrl: process.env.CALENDLY_URL,
      });
      record.source_file = job.file;
      record.audit_log.role_source = job.source;
      if (job.group) record.evaluation_group = job.group;
      await store.insert(record);
      results.push({ ...job, category: record.categorization.category, match: record.scoring.match_score_pct, risk: record.scoring.total_risk_score });
      console.log(`  ✓ ${job.candidateId} ${job.role.padEnd(3)} ${job.file.padEnd(28)} ${record.categorization.category.padEnd(16)} ${record.scoring.match_score_pct}% / risk ${record.scoring.total_risk_score}  (${Math.round((Date.now() - t) / 1000)}s)`);
    } catch (err) {
      results.push({ ...job, error: err.message });
      console.log(`  ✗ ${job.role.padEnd(3)} ${job.file}: ${err.message}`);
    }
  });

  // Covers pairs from earlier (interrupted) runs too, not just this one.
  await resolveGroups([...new Set((await store.readAll()).map(r => r.evaluation_group).filter(Boolean))]);

  if (opts.send) {
    const queued = (await store.readAll()).filter(r => r.categorization.category === 'LOW_POTENTIAL' && r.email_status === 'QUEUED');
    for (const r of queued) {
      try {
        await deliverEmail(r.candidate_id);
      } catch (err) {
        console.log(`  email not sent for ${r.candidate_id}: ${err.message}`);
        if (/RESEND_API_KEY/.test(err.message)) break;
      }
    }
  }

  const count = c => results.filter(r => r.category === c).length;
  console.log(`\nDone in ${Math.round((Date.now() - started) / 60000)} min: ${count('HIGH_POTENTIAL')} high, ${count('MEDIUM_POTENTIAL')} medium, ${count('LOW_POTENTIAL')} low, ${results.filter(r => r.error).length} failed.`);
  if (!opts.send) console.log('Low-potential rejections are queued in the Review tab (run with --send to schedule them).');
}

if (require.main === module) {
  main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => store.close());
}

module.exports = { rolesFor, resolveGroups };

// Calibration check: scores Kargo's past-hire CVs against both rubrics and
// compares the result with their actual ratings. Stores nothing and sends no
// email; run it after any rubric change.
//
//   node scripts/calibrate.js <hires-folder> [--concurrency 3]
//
// Expected: every Exceeds hire outranks every Meets/Below hire on the rubric
// for the role family they'd map to. The rubric was derived from these same
// profiles, so this checks consistency, not predictive accuracy.

require('../lib/env').loadDotEnv();

const fs = require('fs');
const path = require('path');
const { evaluateCv } = require('../lib/pipeline');
const { pdfToText } = require('../lib/pdf');
const { docxToText } = require('../lib/docx');
const { HISTORICAL_HIRES, RUBRIC_VERSION } = require('../lib/rubric');

async function readText(file) {
  const buf = fs.readFileSync(file);
  if (/\.docx$/i.test(file)) return docxToText(buf);
  if (/\.pdf$/i.test(file)) return pdfToText(buf);
  return buf.toString('utf-8');
}

function hireFor(file) {
  const base = path.basename(file).toLowerCase();
  return HISTORICAL_HIRES.find(h => h.name.toLowerCase().split(' ').every(w => base.includes(w)));
}

async function main() {
  const dir = process.argv[2];
  const ci = process.argv.indexOf('--concurrency');
  const concurrency = ci > -1 ? Number(process.argv[ci + 1]) || 3 : 3;
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: node scripts/calibrate.js <hires-folder> [--concurrency 3]');
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter(f => /\.(docx|pdf|txt)$/i.test(f)).sort();
  const jobs = files.flatMap(f => ['PM', 'SPM'].map(role => ({ file: f, role, hire: hireFor(f) })));
  console.log(`Calibrating rubric ${RUBRIC_VERSION} on ${files.length} past hires x 2 rubrics`);

  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const rec = await evaluateCv({
          rawText: await readText(path.join(dir, job.file)),
          roleCode: job.role,
          overrides: { filename: job.file },
          candidateId: `CAL-${job.role}-${job.file}`,
          calendlyUrl: null,
        });
        results.push({ ...job, match: rec.scoring.match_score_pct, risk: rec.scoring.total_risk_score, category: rec.categorization.category,
          flags: rec.risk_assessment.active_risk_flags.map(f => f.flag.replace('_RISK', '')).join(', ') || '-',
          scores: Object.values(rec.scoring.parameter_scores).map(p => p.score).join('/') });
      } catch (err) {
        results.push({ ...job, error: err.message });
      }
    }
  }));

  for (const role of ['PM', 'SPM']) {
    console.log(`\n${role} rubric`);
    const rows = results.filter(r => r.role === role).sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
    for (const r of rows) {
      const who = r.hire ? `${r.hire.name} (${r.hire.rating.replace(' Expectations', '')})` : r.file;
      console.log(r.error
        ? `  ${who.padEnd(34)} ERROR ${r.error}`
        : `  ${who.padEnd(34)} ${String(r.match).padStart(5)}%  risk ${String(r.risk).padStart(3)}  ${r.category.padEnd(16)} scores ${r.scores}  flags ${r.flags}`);
    }
    const ok = rows.filter(r => !r.error && r.hire);
    const minTop = Math.min(...ok.filter(r => r.hire.fit === 'top').map(r => r.match));
    const maxMis = Math.max(...ok.filter(r => r.hire.fit === 'misfit').map(r => r.match));
    console.log(`  -> lowest Exceeds ${minTop}% vs highest Meets/Below ${maxMis}%: ${minTop > maxMis ? 'separated' : 'OVERLAP'}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

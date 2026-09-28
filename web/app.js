const PARAM_LABELS = {
  p1_technical_integration: ['Integration architecture & technical depth', 30],
  p2_domain_depth: ['Domain depth & operational realities', 25],
  p3_autonomous_scrappiness: ['Autonomous execution in ambiguity', 25],
  p4_cross_functional_alignment: ['Cross-functional alignment & deal unblocking', 20],
  p1_customer_discovery: ['Ground-level customer discovery', 30],
  p2_scrappiness_velocity: ['0-to-1 scrappiness & shipping velocity', 30],
  p3_engineering_alignment: ['Engineering alignment & sprint execution', 20],
  p4_metric_driven_adoption: ['Metric-driven unforced adoption', 20],
};
const CAT_LABEL = { HIGH_POTENTIAL: 'High potential', MEDIUM_POTENTIAL: 'Medium potential', LOW_POTENTIAL: 'Auto-rejected' };
const FLAG_LABEL = {
  ENTERPRISE_DEPENDENCY_RISK: 'Enterprise dependency',
  DOMAIN_MISALIGNMENT_RISK: 'Domain misalignment / B2C',
  INFORMATION_GAP_RISK: 'Information gap',
};

const $ = (sel, root = document) => root.querySelector(sel);
let config = {};

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function li(text) {
  const el = document.createElement('li');
  el.textContent = text;
  return el;
}

async function loadConfig() {
  config = await api('/api/config');
  const missing = [];
  if (!config.llm_configured) missing.push(`${config.llm_provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} (needed to evaluate CVs)`);
  if (!config.resend_configured) missing.push('RESEND_API_KEY (needed to send email)');
  if (!config.calendly_url) missing.push('CALENDLY_URL (invites keep a [Calendly Link] placeholder)');
  const warn = $('#config-warning');
  warn.hidden = missing.length === 0;
  const cvInput = document.querySelector('input[name=cv]');
  if (cvInput && config.max_files_per_upload) cvInput.title = `Up to ${config.max_files_per_upload} CVs per upload`;
  warn.textContent = missing.length ? `Not configured in kargo-hiring/.env: ${missing.join(' · ')}` : '';
}

function renderStats(s) {
  const items = [
    ['Evaluated', s.total_evaluated],
    ['High', s.high],
    ['Medium', s.medium],
    ['Auto-rejected', s.auto_rejected],
    ['Invites sent', s.invites_sent],
  ];
  $('#stats').replaceChildren(...items.map(([k, v]) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<b></b><span></span>`;
    d.querySelector('b').textContent = v;
    d.querySelector('span').textContent = k;
    return d;
  }));

  const pending = s.medium_awaiting + s.rejections_queued;
  const badge = $('#review-badge');
  badge.hidden = pending === 0;
  badge.textContent = pending;
}

const STATE_LABEL = {
  DRAFT: ['Draft', 'draft'], QUEUED: ['Queued', 'draft'], SENT: ['Sent', 'ok'], SCHEDULED: ['Scheduled', 'ok'],
  HELD: ['Held · other role or duplicate', 'draft'],
};

function renderRow(r) {
  const node = $('#row-tpl').content.firstElementChild.cloneNode(true);
  const isInvite = r.email.type === 'INTERVIEW_INVITE';
  const done = ['SENT', 'SCHEDULED', 'HELD'].includes(r.email_status);

  $('.q-name', node).textContent = r.candidate_name;
  $('.q-meta', node).textContent = `${r.candidate_id} · ${r.selected_role}`;
  const cat = $('.q-cat', node);
  cat.textContent = r.status === 'PASSED_BY_FOUNDER' ? 'Passed by Arjun' : CAT_LABEL[r.category];
  cat.classList.add(r.category === 'LOW_POTENTIAL' ? 'low' : 'med');
  $('.q-match', node).textContent = `${r.match_score_pct}%`;
  $('.q-risk', node).textContent = r.total_risk_score;
  $('.q-reason', node).textContent = r.reason;
  const flags = $('.q-flags', node);
  for (const f of r.risk_flags) {
    const s = document.createElement('span');
    s.className = 'flag';
    s.textContent = FLAG_LABEL[f] || f;
    flags.appendChild(s);
  }

  const [stateText, stateCls] = STATE_LABEL[r.email_status] || [r.email_status, 'draft'];
  const state = $('.q-state', node);
  state.textContent = r.email_status === 'SCHEDULED' && r.last_email_event && r.last_email_event.scheduled_at
    ? `${r.category === 'LOW_POTENTIAL' ? 'Auto-scheduled · ' : ''}arrives ${new Date(r.last_email_event.scheduled_at).toLocaleDateString()}`
    : r.category === 'LOW_POTENTIAL' && r.email_status === 'QUEUED'
      ? (r.last_email_event && r.last_email_event.error ? 'Send failed' : 'Not sent')
      : stateText;
  state.classList.add(stateCls);

  const to = $('.e-to', node), subj = $('.e-subject', node), body = $('.e-body', node);
  const status = $('.q-status', node);
  to.value = r.email.recipient_email || '';
  subj.value = r.email.subject;
  body.value = r.email.body_text;
  const emailBox = $('.q-email', node);
  $('.q-toggle', node).addEventListener('click', () => (emailBox.hidden = !emailBox.hidden));

  // Low-potential rejections go out automatically; the button only appears
  // as a retry if that automatic send failed.
  const isAuto = r.category === 'LOW_POTENTIAL';
  const send = $('.q-send', node);
  send.textContent = isInvite ? 'Invite' : isAuto ? 'Retry' : 'Approve';
  send.hidden = done;
  if (isAuto && r.email_status === 'QUEUED' && r.last_email_event && r.last_email_event.error) {
    status.textContent = `Automatic send failed: ${r.last_email_event.error}`;
  }
  const reject = $('.q-reject', node);
  reject.hidden = !isInvite;
  if (done) {
    [to, subj, body].forEach(el => (el.disabled = true));
    send.disabled = reject.disabled = true;
  }

  send.addEventListener('click', async () => {
    if (!to.value) { emailBox.hidden = false; status.textContent = 'Add a recipient email first.'; return; }
    send.disabled = true;
    try {
      await api(`/api/candidates/${r.candidate_id}/email`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_email: to.value, subject: subj.value, body_text: body.value }),
      });
      await api(`/api/candidates/${r.candidate_id}/send`, { method: 'POST' });
      await refreshReview();
    } catch (err) {
      emailBox.hidden = false;
      status.textContent = err.message;
      send.disabled = false;
    }
  });

  reject.addEventListener('click', async () => {
    try {
      await api(`/api/candidates/${r.candidate_id}/pass`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await refreshReview();
    } catch (err) {
      emailBox.hidden = false;
      status.textContent = err.message;
    }
  });

  return node;
}

async function refreshReview() {
  const [{ medium, rejections, rejection_delay_hours }, { stats }] = await Promise.all([api('/api/review'), api('/api/dashboard')]);
  renderStats(stats);
  const empty = text => Object.assign(document.createElement('p'), { className: 'empty muted', textContent: text });
  $('#medium-list').replaceChildren(...(medium.length ? medium.map(renderRow) : [empty('No medium-potential candidates.')]));
  $('#rejection-list').replaceChildren(...(rejections.length ? rejections.map(renderRow) : [empty('No rejection emails.')]));
  const queued = rejections.filter(r => r.email_status === 'QUEUED').length;
  $('#queue-note').textContent = `Low-potential rejections are scheduled automatically. Rejections for candidates you pass on wait for your approval. All arrive ${rejection_delay_hours}h after scheduling. ${queued} waiting.`;
  $('#batch-btn').disabled = queued === 0;
}

function renderCard(c) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const cat = c.categorization.category;
  node.classList.add(cat === 'HIGH_POTENTIAL' ? 'high' : 'medium');
  $('.name', node).textContent = c.candidate_name;
  $('.meta', node).textContent = `${c.candidate_id} · ${c.selected_role} · closest to: ${c.categorization.closest_historical_match}`;
  $('.cat', node).textContent = CAT_LABEL[cat];
  $('.match', node).textContent = `${c.scoring.match_score_pct}%`;
  $('.risk', node).textContent = c.scoring.total_risk_score;
  $('.reason', node).textContent = c.categorization.recommendation_reason;

  const params = $('.params', node);
  for (const [key, v] of Object.entries(c.scoring.parameter_scores)) {
    const [label, weight] = PARAM_LABELS[key] || [key, ''];
    const el = document.createElement('li');
    el.innerHTML = `<div class="p-head"><span></span><b></b></div><div class="bar"><i></i></div><p class="muted"></p>`;
    el.querySelector('span').textContent = `${label} (${weight}%)`;
    el.querySelector('b').textContent = `${v.score}/5`;
    el.querySelector('i').style.width = `${v.score * 20}%`;
    el.querySelector('p').textContent = v.evidence;
    params.appendChild(el);
  }

  const flags = $('.flags', node);
  const active = c.risk_assessment.active_risk_flags;
  if (!active.length) flags.appendChild(li('None detected'));
  for (const f of active) {
    const el = li('');
    el.innerHTML = '<b></b> <span class="muted"></span>';
    el.querySelector('b').textContent = `${FLAG_LABEL[f.flag] || f.flag} +${f.points}`;
    el.querySelector('span').textContent = f.evidence;
    flags.appendChild(el);
  }

  const b = c.deliverables.interview_brief;
  $('.summary', node).textContent = b.summary;
  $('.why', node).textContent = b.why_ranked_here;
  b.key_strengths.forEach(s => $('.strengths', node).appendChild(li(s)));
  b.risk_factors.forEach(s => $('.risks', node).appendChild(li(s)));
  b.interview_probes.forEach(s => $('.probes', node).appendChild(li(s)));

  const d = c.deliverables.resend_email_draft;
  const to = $('.e-to', node), subj = $('.e-subject', node), body = $('.e-body', node);
  to.value = d.recipient_email || '';
  subj.value = d.subject;
  body.value = d.body_text;

  const sent = c.email_status === 'SENT';
  const state = $('.email-state', node);
  state.textContent = sent ? 'Sent' : 'Draft';
  state.classList.add(sent ? 'ok' : 'draft');
  const sendBtn = $('.send', node), passBtn = $('.pass', node), status = $('.card-status', node);
  if (sent) {
    [to, subj, body].forEach(el => (el.disabled = true));
    sendBtn.disabled = passBtn.disabled = true;
    const last = c.email_history.filter(h => h.resend_id).pop();
    status.textContent = last ? `Sent ${new Date(last.at).toLocaleString()}` : '';
  }

  const save = () => api(`/api/candidates/${c.candidate_id}/email`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_email: to.value, subject: subj.value, body_text: body.value }),
  });

  sendBtn.addEventListener('click', async () => {
    if (!to.value) { status.textContent = 'Add a recipient email first.'; return; }
    sendBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      await save();
      await api(`/api/candidates/${c.candidate_id}/send`, { method: 'POST' });
      await refresh();
    } catch (err) {
      status.textContent = err.message;
      sendBtn.disabled = false;
    }
  });

  passBtn.addEventListener('click', async () => {
    if (!confirm(`Pass on ${c.candidate_name}? A polite rejection will be added to the delayed queue.`)) return;
    try {
      await api(`/api/candidates/${c.candidate_id}/pass`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await refresh();
    } catch (err) {
      status.textContent = err.message;
    }
  });

  return node;
}

async function refresh() {
  const { candidates, stats } = await api('/api/dashboard');
  renderStats(stats);
  const list = $('#candidates');
  if (!candidates.length) {
    list.innerHTML = '<p class="empty muted">No high-potential candidates yet. Medium candidates and rejections are in the Review queue tab.</p>';
    return;
  }
  list.replaceChildren(...candidates.map(renderCard));
}

async function refreshAudit() {
  const { records } = await api('/api/audit');
  const tbody = $('#audit-table tbody');
  tbody.replaceChildren();
  for (const r of records) {
    const tr = document.createElement('tr');
    const cells = [
      r.candidate_id, r.candidate_name, r.selected_role, `${r.scoring.match_score_pct}%`,
      r.scoring.total_risk_score, CAT_LABEL[r.categorization.category], r.status, r.email_status,
    ];
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tr.children[5].className = `cat-${r.categorization.category}`;
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'Details';
    td.appendChild(btn);
    tr.appendChild(td);

    const detail = document.createElement('tr');
    detail.hidden = true;
    const dtd = document.createElement('td');
    dtd.colSpan = cells.length + 1;
    dtd.innerHTML = '<h4>Rationale</h4><p class="rationale"></p><h4>Risk summary</h4><p class="rs"></p><details><summary>Full record JSON</summary><pre></pre></details>';
    dtd.querySelector('.rationale').textContent = r.audit_log.full_evaluation_rationale;
    dtd.querySelector('.rs').textContent = r.risk_assessment.risk_summary;
    dtd.querySelector('pre').textContent = JSON.stringify(r, null, 2);
    detail.appendChild(dtd);
    btn.addEventListener('click', () => (detail.hidden = !detail.hidden));
    tbody.append(tr, detail);
  }
  if (!records.length) tbody.innerHTML = '<tr><td colspan="9" class="muted">No evaluations yet.</td></tr>';
}

$('#upload').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const btn = $('#upload-btn');
  const files = form.cv.files;
  btn.disabled = true;
  $('#upload-status').textContent = `Evaluating ${files.length} CV${files.length > 1 ? 's' : ''}. This takes about a minute each…`;
  $('#upload-results').replaceChildren();
  try {
    const { results } = await api('/api/candidates', { method: 'POST', body: new FormData(form) });
    $('#upload-results').replaceChildren(...results.map(r => {
      if (r.error) return Object.assign(li(`${r.file}: failed (${r.error})`), { className: 'err' });
      const msg = {
        HIGH_POTENTIAL: `${r.file} → ${r.candidate_name}: High potential, added to shortlist`,
        MEDIUM_POTENTIAL: `${r.file} → ${r.candidate_name}: Medium potential, added to Review queue`,
        LOW_POTENTIAL: r.rejection_email && r.rejection_email.scheduled
          ? `${r.file} → ${r.candidate_id}: auto-rejected, rejection email scheduled`
          : `${r.file} → ${r.candidate_id}: auto-rejected, rejection email NOT sent (${r.rejection_email ? r.rejection_email.error : 'unknown error'}). Retry from Review queue`,
      }[r.category];
      return Object.assign(li(msg), { className: r.category === 'LOW_POTENTIAL' ? 'muted' : 'ok' });
    }));
    form.reset();
    await refresh();
  } catch (err) {
    $('#upload-results').replaceChildren(Object.assign(li(err.message), { className: 'err' }));
  } finally {
    btn.disabled = false;
    $('#upload-status').textContent = '';
  }
});

$('#batch-btn').addEventListener('click', async () => {
  const btn = $('#batch-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/rejections/send-batch', { method: 'POST' });
    await refreshReview();
    $('#queue-note').textContent = `Scheduled ${r.scheduled} for ${new Date(r.scheduled_at).toLocaleString()}.` +
      (r.failures.length ? ` ${r.failures.length} failed: ${r.failures[0].error}` : '');
  } catch (err) {
    $('#queue-note').textContent = err.message;
    btn.disabled = false;
  }
});

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  const view = tab.dataset.view;
  for (const v of ['dashboard', 'review', 'audit']) $(`#view-${v}`).hidden = view !== v;
  ({ dashboard: refresh, review: refreshReview, audit: refreshAudit })[view]();
}));

loadConfig().then(refresh).catch(err => {
  $('#candidates').textContent = err.message;
});

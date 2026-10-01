const PARAM_LABELS = {
  // Current rubric
  p1_integration_judgment: ['Integration & platform judgment', 30],
  p2_operations_depth: ['Ground-level operations depth', 30],
  p3_autonomous_calls: ['Autonomous calls in ambiguity', 25],
  p4_cross_functional_unblocking: ['Cross-functional unblocking & standards', 15],
  p1_operations_immersion: ['Ground-level operations immersion', 30],
  p2_ship_and_kill: ['Ship, learn & kill in short cycles', 25],
  p3_unforced_adoption: ['Unforced adoption with operational impact', 25],
  p4_engineering_trust: ['Engineering trust & self-built rhythm', 20],
  // Earlier rubric (audit log only)
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
  NO_OPERATIONS_EXPOSURE_RISK: 'No operations exposure',
  STRUCTURE_DEPENDENCY_RISK: 'Structure dependency',
  INFORMATION_GAP_RISK: 'Information gap',
  ENTERPRISE_DEPENDENCY_RISK: 'Enterprise dependency',
  DOMAIN_MISALIGNMENT_RISK: 'Domain misalignment / B2C',
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

let statsShown = false;

function renderStats(s) {
  const items = [
    ['Evaluated', s.total_evaluated, ''],
    ['High', s.high, 'high'],
    ['Medium', s.medium, 'med'],
    ['Auto-rejected', s.auto_rejected, 'low'],
    ['Invites sent', s.invites_sent, 'sent'],
  ];
  const box = $('#stats');
  box.replaceChildren(...items.map(([k, v, cls]) => {
    const d = document.createElement('div');
    d.className = `stat ${cls}`;
    d.innerHTML = '<span class="k"><i></i><span></span></span><b></b>';
    d.querySelector('.k span').textContent = k;
    const num = d.querySelector('b');
    num.dataset.count = v;
    num.textContent = v;
    return d;
  }));
  Motion.stats(box, { animateNumbers: !statsShown });

  // Pipeline bar: share of High / Medium / Low among everything evaluated.
  const bar = $('#pipeline-bar');
  const total = s.high + s.medium + s.auto_rejected;
  bar.replaceChildren(...[['high', s.high], ['med', s.medium], ['low', s.auto_rejected]].filter(([, n]) => n > 0).map(([cls, n]) => {
    const seg = document.createElement('span');
    seg.className = `seg-fill ${cls}`;
    seg.dataset.grow = n;
    seg.title = `${n} ${cls === 'high' ? 'high' : cls === 'med' ? 'medium' : 'low'} potential`;
    return seg;
  }));
  bar.hidden = total === 0;
  Motion.pipeline(bar, !statsShown);

  const shortlisted = s.high + (s.reconsidered || 0);
  const parts = [];
  parts.push(`<b>${s.high}</b> ready to interview`);
  if (s.medium_awaiting) parts.push(`<b>${s.medium_awaiting}</b> waiting for your call`);
  if (s.rejections_queued) parts.push(`<b>${s.rejections_queued}</b> rejection mail${s.rejections_queued === 1 ? '' : 's'} to send`);
  Motion.swapText($('#hero-sub'), s.total_evaluated
    ? `${parts.join(' · ')}. ${s.total_evaluated} CVs evaluated so far.`
    : 'No CVs evaluated yet. Drop a few below to build your first shortlist.');
  void shortlisted;
  statsShown = true;

  const pending = s.medium_awaiting + s.rejections_queued;
  const badge = $('#review-badge');
  const changed = badge.textContent !== String(pending);
  badge.hidden = pending === 0;
  badge.textContent = pending;
  if (changed && !badge.hidden) Motion.pulse(badge);
}

const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Plain-language state of a rejection email.
function rejectionState(r) {
  const ev = r.last_email_event;
  if (r.email_status === 'SENT') return ['Sent', 'ok'];
  if (r.email_status === 'SCHEDULED') return [ev && ev.scheduled_at ? `Scheduled · arrives ${fmtDate(ev.scheduled_at)}` : 'Scheduled', 'ok'];
  if (r.email_status === 'HELD') return ['No email needed · in play for the other role', 'draft'];
  return ['Not sent', 'draft'];
}

function renderRow(r) {
  const node = $('#row-tpl').content.firstElementChild.cloneNode(true);
  const isMedium = r.email.type === 'INTERVIEW_INVITE';
  node.dataset.match = r.match_score_pct;
  node.classList.toggle('is-low', r.category === 'LOW_POTENTIAL');
  $('.q-ring-val', node).textContent = Math.round(r.match_score_pct);

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
    const el = document.createElement('span');
    el.className = 'flag';
    el.textContent = FLAG_LABEL[f] || f;
    flags.appendChild(el);
  }

  const status = $('.q-status', node);
  const say = text => { status.hidden = !text; status.textContent = text; };
  const primary = $('.q-primary', node);
  const secondary = $('.q-secondary', node);

  if (isMedium) {
    secondary.hidden = false;
    secondary.textContent = 'Open detailed summary';
    secondary.addEventListener('click', () => openDetail(r.candidate_id));
    const reject = $('.q-reject', node);
    reject.hidden = false;
    reject.textContent = 'Send rejection mail';
    reject.addEventListener('click', async () => {
      reject.disabled = true;
      composeRejection({ candidate_id: r.candidate_id, candidate_name: r.candidate_name, draft: r.rejection_email }, afterRejectInReview);
      reject.disabled = false;
    });
    primary.hidden = false;
    primary.textContent = 'Reconsider';
    primary.addEventListener('click', async () => {
      primary.disabled = true;
      try {
        await reconsider(r.candidate_id, node);
      } catch (err) {
        say(err.message);
        primary.disabled = false;
      }
    });
    return node;
  }

  // Rejection row: a status, and one button while the email hasn't gone out.
  const [stateText, stateCls] = rejectionState(r);
  const state = $('.q-state', node);
  state.hidden = false;
  state.textContent = stateText;
  state.classList.add(stateCls);

  if (r.email_status === 'QUEUED') {
    primary.hidden = false;
    primary.textContent = 'Send rejection mail';
    primary.addEventListener('click', () => {
      composer.open({
        kind: 'rejection',
        name: r.candidate_name,
        draft: r.email,
        onSave: v => patchDraft(r.candidate_id, v),
        onSend: async v => {
          await patchDraft(r.candidate_id, v);
          await api(`/api/candidates/${r.candidate_id}/send`, { method: 'POST' });
          await refreshReview();
        },
      });
    });
  }
  return node;
}

// ---------- Email composer: every email is reviewed (and editable) before it goes out ----------
const patchDraft = (id, fields, draft) => api(`/api/candidates/${id}/email`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...fields, ...(draft ? { draft } : {}) }),
});

const composer = (() => {
  const dialog = $('#compose-dialog');
  const f = { to: $('#compose-to'), subject: $('#compose-subject'), message: $('#compose-message') };
  const err = $('#compose-error');
  const saved = $('#compose-saved');
  const sendBtn = $('#compose-send');
  const saveBtn = $('#compose-save');
  let job = null;

  const values = () => ({ recipient_email: f.to.value.trim(), subject: f.subject.value.trim(), body_text: f.message.value });
  const showError = m => { err.hidden = !m; err.textContent = m || ''; };
  const busy = on => { sendBtn.disabled = saveBtn.disabled = on; };
  const close = () => { if (dialog.open) Motion.dialogOut(dialog, () => dialog.close()); };

  function open({ kind, name, draft, onSend, onSave }) {
    job = { onSend, onSave };
    const invite = kind === 'invite';
    $('#compose-kicker').textContent = invite ? 'Interview invite' : 'Rejection mail';
    $('#compose-kicker').className = `kicker ${invite ? '' : 'kicker-low'}`;
    $('#compose-title').textContent = invite ? `Invite ${name}` : `Reject ${name}`;
    $('#compose-from').textContent = config.email_from || '';
    const test = $('#compose-test');
    test.hidden = !config.email_override_to;
    test.textContent = config.email_override_to
      ? `Test mode: this email will be delivered to ${config.email_override_to}, not to the address below. The candidate's address is kept on their record.`
      : '';
    f.to.value = draft.recipient_email || '';
    f.subject.value = draft.subject || '';
    f.message.value = draft.body_text || '';
    $('#compose-note').textContent = invite
      ? 'Sends as soon as you click Send. Edit anything above first; your changes are saved with the candidate.'
      : `Arrives ${config.rejection_delay_hours} hours after you click Send, so it doesn't feel automated. Edit anything above first.`;
    sendBtn.querySelector('span').textContent = invite ? 'Send invite' : 'Send rejection mail';
    saved.textContent = '';
    showError('');
    busy(false);
    dialog.showModal();
    Motion.dialogIn(dialog);
    // Start at the top so From / To are in view; focus without scrolling away.
    dialog.scrollTop = 0;
    setTimeout(() => { f.message.focus({ preventScroll: true }); dialog.scrollTop = 0; }, 60);
  }

  function validate(v) {
    if (!v.recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.recipient_email)) return 'Enter a valid recipient email address.';
    if (!v.subject) return 'Add a subject line.';
    if (!v.body_text.trim()) return 'The message is empty.';
    return '';
  }

  $('#compose-form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = values();
    const problem = validate(v);
    if (problem) return showError(problem);
    busy(true);
    showError('');
    try {
      await job.onSend(v);
      close();
    } catch (ex) {
      showError(`Couldn't send it: ${ex.message}`);
      busy(false);
    }
  });
  saveBtn.addEventListener('click', async () => {
    busy(true);
    try {
      await job.onSave(values());
      saved.textContent = 'Draft saved';
      Motion.pulse(saved);
    } catch (ex) {
      showError(ex.message);
    }
    busy(false);
  });
  $('#compose-cancel').addEventListener('click', close);
  $('#compose-close').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  return { open };
})();

// Reject a surfaced (High or Medium) candidate with a reviewed rejection mail.
// Their edits are saved first, so nothing is lost if sending fails.
function composeRejection({ candidate_id, candidate_name, draft }, after) {
  composer.open({
    kind: 'rejection',
    name: candidate_name,
    draft,
    onSave: v => patchDraft(candidate_id, v, 'rejection'),
    onSend: async v => {
      await patchDraft(candidate_id, v, 'rejection');
      await api(`/api/candidates/${candidate_id}/pass`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      let note;
      try {
        const sent = await api(`/api/candidates/${candidate_id}/send`, { method: 'POST' });
        note = `Rejection mail to ${candidate_name} sent; it arrives ${fmtDate(sent.scheduled_at)}.`;
      } catch (ex) {
        note = `${candidate_name} moved to Rejection emails with your edits saved, but the mail couldn't be sent yet: ${ex.message}`;
      }
      closeDetail();
      await after(note);
    },
  });
}

async function afterRejectInReview(note) {
  await refreshReview();
  setSectionOpen($('[data-section=rejections]'), true);
  $('#queue-note').textContent = note;
}

async function reconsider(candidateId, node) {
  await api(`/api/candidates/${candidateId}/reconsider`, { method: 'POST' });
  closeDetail();
  await Motion.leave(node);
  await refreshReview();
}

// Full evaluation for a Medium candidate, in a dialog over the Review queue.
async function openDetail(candidateId) {
  const dialog = $('#detail-dialog');
  const body = $('#detail-body');
  $('#detail-title').textContent = 'Candidate summary';
  body.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Loading…' }));
  dialog.showModal();
  Motion.dialogIn(dialog);
  try {
    const c = await api(`/api/candidates/${candidateId}`);
    $('#detail-title').textContent = c.candidate_name;
    const card = renderCard(c, { detail: true });
    body.replaceChildren(card);
    Motion.cards([card], { animate: true });
  } catch (err) {
    body.replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: err.message }));
  }
}

async function refreshReview() {
  const [{ medium, rejections }, { stats }] = await Promise.all([api('/api/review'), api('/api/dashboard')]);
  renderStats(stats);
  const empty = text => Object.assign(document.createElement('p'), { className: 'empty muted', textContent: text });
  loaded.medium = medium;
  renderMedium();
  const rejRows = rejections.map(renderRow);
  $('#rejection-list').replaceChildren(...(rejRows.length ? rejRows : [empty('No rejection emails.')]));
  Motion.rows(rejRows, { animate: true });
  const waiting = rejections.filter(r => r.email_status === 'QUEUED').length;
  $('#medium-count').textContent = `(${medium.length})`;
  $('#rejection-count').textContent = `(${rejections.length}${waiting ? ` · ${waiting} not sent` : ''})`;
  $('#queue-note').textContent = waiting
    ? `${waiting} not sent yet. Each arrives ${config.rejection_delay_hours} hours after you send it.`
    : `All rejection mails are sent or scheduled. Each arrives ${config.rejection_delay_hours} hours after sending.`;
  $('#batch-btn').disabled = waiting === 0;
}

function renderCard(c, { detail = false } = {}) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const cat = c.categorization.category;
  node.classList.add(cat === 'HIGH_POTENTIAL' ? 'high' : 'medium');
  node.dataset.match = c.scoring.match_score_pct;
  $('.avatar', node).textContent = c.candidate_name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('.ring', node).setAttribute('aria-label', `${c.scoring.match_score_pct}% match`);
  if (detail) {
    // Read-only summary: no email editor; full reasoning and Reconsider instead.
    node.classList.add('in-detail');
    $('.email', node).remove();
    $('.rationale-block', node).hidden = false;
    $('.rationale-text', node).textContent = c.full_evaluation_rationale || '';
    $('.detail-actions', node).hidden = false;
    const rejectBtn = $('.detail-reject', node);
    rejectBtn.addEventListener('click', async () => {
      rejectBtn.disabled = true;
      composeRejection({ candidate_id: c.candidate_id, candidate_name: c.candidate_name, draft: c.deliverables.rejection_email_draft }, afterRejectInReview);
      rejectBtn.disabled = false;
    });
    const btn = $('.detail-reconsider', node);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await reconsider(c.candidate_id);
      } catch (err) {
        $('.detail-status', node).textContent = err.message;
        btn.disabled = false;
      }
    });
  }
  $('.name', node).textContent = c.candidate_name;
  $('.meta', node).textContent = `${c.candidate_id} · ${c.selected_role} · closest to: ${c.categorization.closest_historical_match}`;
  $('.cat', node).textContent = c.shortlisted_by_founder ? 'Medium · reconsidered' : CAT_LABEL[cat];
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
    el.querySelector('i').dataset.w = v.score * 20;
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
  const fill = (sel, items, none) => {
    const ul = $(sel, node);
    if (items.length) items.forEach(s => ul.appendChild(li(s)));
    else ul.appendChild(Object.assign(li(none), { className: 'none' }));
  };
  fill('.strengths', b.key_strengths, 'None noted');
  fill('.risks', b.risk_factors, 'None noted');
  b.interview_probes.forEach(s => $('.probes', node).appendChild(li(s)));

  if (detail) return node;

  const d = c.deliverables.resend_email_draft;
  $('.lp-to', node).textContent = d.recipient_email || 'No email found on CV';
  $('.lp-subject', node).textContent = d.subject;
  $('.lp-body', node).textContent = d.body_text;

  const sent = c.email_status === 'SENT';
  const state = $('.email-state', node);
  state.textContent = sent ? 'Sent' : 'Draft';
  state.classList.add(sent ? 'ok' : 'draft');
  const sendBtn = $('.send', node), passBtn = $('.pass', node), status = $('.card-status', node);
  if (sent) {
    sendBtn.disabled = passBtn.disabled = true;
    const last = c.email_history.filter(h => h.resend_id).pop();
    status.textContent = last ? `Sent ${new Date(last.at).toLocaleString()}` : '';
  }

  sendBtn.addEventListener('click', () => {
    composer.open({
      kind: 'invite',
      name: c.candidate_name,
      draft: d,
      onSave: async v => { await patchDraft(c.candidate_id, v); Object.assign(d, v); },
      onSend: async v => {
        await patchDraft(c.candidate_id, v);
        await api(`/api/candidates/${c.candidate_id}/send`, { method: 'POST' });
        await refresh();
      },
    });
  });

  passBtn.addEventListener('click', () => {
    composeRejection({ candidate_id: c.candidate_id, candidate_name: c.candidate_name, draft: c.deliverables.rejection_email_draft }, async note => {
      await refresh();
      status.textContent = note;
    });
  });

  return node;
}

// Minimum-match filters for the Shortlist and Medium list; remembered per browser.
const filters = { shortlist: 0, medium: 0 };
const loaded = { shortlist: [], medium: [] };

function applyFilter(name, items, matchOf) {
  const min = filters[name];
  const shown = items.filter(x => matchOf(x) >= min);
  const bar = document.querySelector(`[data-filter=${name}]`);
  $('.filter-showing', bar).textContent = items.length
    ? (min ? `Showing ${shown.length} of ${items.length}` : `${items.length} candidate${items.length === 1 ? '' : 's'}`)
    : '';
  return shown;
}

function renderShortlist({ animate = true } = {}) {
  const list = $('#candidates');
  const shown = applyFilter('shortlist', loaded.shortlist, c => c.scoring.match_score_pct);
  if (!loaded.shortlist.length) {
    list.innerHTML = '<p class="empty muted">No shortlisted candidates yet. Medium candidates you reconsider in the Review queue also appear here.</p>';
  } else if (!shown.length) {
    list.innerHTML = `<p class="empty muted">No shortlisted candidates at ${filters.shortlist}% match or above.</p>`;
  } else {
    const cards = shown.map(c => renderCard(c));
    list.replaceChildren(...cards);
    Motion.cards(cards, { animate });
  }
}

function renderMedium({ animate = true } = {}) {
  const empty = text => Object.assign(document.createElement('p'), { className: 'empty muted', textContent: text });
  const shown = applyFilter('medium', loaded.medium, r => r.match_score_pct);
  const rows = shown.map(renderRow);
  $('#medium-list').replaceChildren(...(rows.length ? rows
    : [empty(loaded.medium.length ? `No medium-potential candidates at ${filters.medium}% match or above.` : 'No medium-potential candidates waiting.')]));
  Motion.rows(rows, { animate });
}

document.querySelectorAll('.filter-bar').forEach(bar => {
  const name = bar.dataset.filter;
  const input = $('.filter-min', bar);
  const out = $('.filter-val', bar);
  try { filters[name] = Number(localStorage.getItem(`kargo.filter.${name}`)) || 0; } catch {}
  const paint = () => { out.textContent = `${filters[name]}%`; input.style.setProperty('--fill', `${filters[name]}%`); };
  input.value = filters[name];
  paint();
  input.addEventListener('input', () => {
    filters[name] = Number(input.value);
    paint();
    try { localStorage.setItem(`kargo.filter.${name}`, String(filters[name])); } catch {}
    (name === 'shortlist' ? renderShortlist : renderMedium)({ animate: false });
  });
});

async function refresh() {
  const { candidates, stats } = await api('/api/dashboard');
  renderStats(stats);
  loaded.shortlist = candidates;
  renderShortlist();
}

async function refreshAudit() {
  const { records } = await api('/api/audit');
  const tbody = $('#audit-table tbody');
  tbody.replaceChildren();
  for (const r of records) {
    const tr = document.createElement('tr');
    const cells = [
      r.candidate_id, r.candidate_name, r.selected_role, `${r.scoring.match_score_pct}%`,
      r.scoring.total_risk_score, CAT_LABEL[r.categorization.category] + (r.rubric_version === config.rubric_version ? "" : " (old rubric)"), r.status, r.email_status,
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
  Motion.tableRows(tbody);
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

// Open/close the Medium and Rejection sections; remembered per browser.
function setSectionOpen(panel, open, { instant = false } = {}) {
  const was = !panel.classList.contains('closed');
  panel.classList.toggle('closed', !open);
  const bodies = [...panel.querySelectorAll('.section-body')];
  if (instant || was === open) bodies.forEach(el => (el.hidden = !open));
  else Motion.section(bodies, open);
  const btn = $('.section-toggle', panel);
  btn.textContent = open ? 'Close' : 'Open';
  btn.setAttribute('aria-expanded', String(open));
}
document.querySelectorAll('.collapsible').forEach(panel => {
  const key = `kargo.section.${panel.dataset.section}`;
  let open = true;
  try { open = localStorage.getItem(key) !== 'closed'; } catch {}
  setSectionOpen(panel, open, { instant: true });
  $('.section-toggle', panel).addEventListener('click', () => {
    const next = panel.classList.contains('closed');
    setSectionOpen(panel, next);
    try { localStorage.setItem(key, next ? 'open' : 'closed'); } catch {}
  });
});

function closeDetail() {
  const dialog = $('#detail-dialog');
  if (dialog.open) Motion.dialogOut(dialog, () => dialog.close());
}
$('#detail-close').addEventListener('click', closeDetail);
$('#detail-dialog').addEventListener('click', e => { if (e.target.id === 'detail-dialog') closeDetail(); });
$('#detail-dialog').addEventListener('cancel', e => { e.preventDefault(); closeDetail(); });

$('#batch-btn').addEventListener('click', async () => {
  const btn = $('#batch-btn');
  if (!confirm('Send every rejection mail that has not gone out yet?')) return;
  btn.disabled = true;
  try {
    const r = await api('/api/rejections/send-batch', { method: 'POST' });
    await refreshReview();
    $('#queue-note').textContent = (r.scheduled ? `Sent ${r.scheduled} rejection mail${r.scheduled === 1 ? '' : 's'}; they arrive ${fmtDate(r.scheduled_at)}.` : '') +
      (r.failures.length ? ` ${r.failures.length} couldn't be sent: ${r.failures[0].error}` : '');
  } catch (err) {
    $('#queue-note').textContent = err.message;
    btn.disabled = false;
  }
});

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  if (tab.classList.contains('active')) return;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t === tab);
    t.setAttribute('aria-selected', String(t === tab));
  });
  Motion.indicator(tab);
  const view = tab.dataset.view;
  for (const v of ['dashboard', 'review', 'audit']) $(`#view-${v}`).hidden = view !== v;
  Motion.view($(`#view-${view}`));
  ({ dashboard: refresh, review: refreshReview, audit: refreshAudit })[view]();
}));
const placeIndicator = () => Motion.indicator($('.tab.active'), true);
window.addEventListener('resize', placeIndicator);
(document.fonts ? document.fonts.ready : Promise.resolve()).then(placeIndicator);

// Dropzone: show chosen files, highlight on drag.
(() => {
  const zone = $('#dropzone');
  const input = $('input[name=cv]', zone);
  const title = $('#dz-title');
  const sub = $('#dz-sub');
  const idle = [title.innerHTML, sub.textContent];
  const show = () => {
    const files = [...input.files];
    if (!files.length) { title.innerHTML = idle[0]; sub.textContent = idle[1]; return; }
    title.textContent = files.length === 1 ? files[0].name : `${files.length} CVs selected`;
    sub.textContent = files.length === 1 ? `${Math.max(1, Math.round(files[0].size / 1024))} KB · ready to evaluate` : files.map(f => f.name).slice(0, 3).join(', ') + (files.length > 3 ? '…' : '');
  };
  input.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, () => zone.classList.add('drag')));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove('drag')));
  $('#upload').addEventListener('reset', () => setTimeout(show));
})();

// Greeting and date in the hero, set before the intro animation splits the words.
(() => {
  const now = new Date();
  const h = now.getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  $('#hero-title').innerHTML = `Good ${part}, <em>Arjun.</em>`;
  $('#hero-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · Hiring desk';
  Motion.intro();
})();

loadConfig().then(refresh).catch(err => {
  $('#candidates').textContent = err.message;
});

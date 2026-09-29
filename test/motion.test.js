// Exercises web/motion.js as a *visible* page with a GSAP stand-in, so every
// animation path runs (the in-app preview is often hidden, which skips them).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeTween(vars) {
  let p = 0;
  return {
    delay: () => vars.delay || 0,
    totalDuration: () => vars.duration || 0,
    progress(v) { if (v === undefined) return p; p = v; if (p === 1 && vars.onComplete) vars.onComplete(); return this; },
  };
}

function fakeGsap(calls) {
  const tween = kind => (target, a, b) => { calls.push(kind); return fakeTween(b || a || {}); };
  const tl = {
    from() { calls.push('tl.from'); return tl; },
    ...fakeTween({ duration: 1 }),
  };
  return { to: tween('to'), from: tween('from'), fromTo: tween('fromTo'), set: () => calls.push('set'), timeline: () => { calls.push('timeline'); return tl; }, registerPlugin() {} };
}

function el(extra = {}) {
  return {
    style: { setProperty() {} }, dataset: {}, textContent: '', innerHTML: '', hidden: false, offsetLeft: 10, offsetWidth: 80,
    getAttribute: () => '16', querySelector: () => null, querySelectorAll: () => [], ...extra,
  };
}

function load({ hidden = false, search = '' } = {}) {
  const calls = [];
  const window = { gsap: fakeGsap(calls), matchMedia: () => ({ matches: false }) };
  const document = { hidden, querySelector: () => el(), querySelectorAll: () => [] };
  const context = { window, document, location: { search }, setTimeout: (fn) => fn(), Math, Number, String };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'motion.js'), 'utf8'), context);
  return { Motion: window.Motion, calls };
}

test('every motion function runs on a visible page without recursion', () => {
  const { Motion, calls } = load();
  assert.strictEqual(Motion.enabled, true);
  const ring = el();
  const card = el({ dataset: { match: '80' }, querySelector: () => ring, querySelectorAll: () => [el({ dataset: { w: '60' } })] });
  const row = el({ dataset: { match: '70' }, querySelector: () => ring });
  Motion.intro();
  Motion.swapText(el(), '<b>1</b>');
  Motion.stats(el({ querySelectorAll: () => [el({ dataset: { count: '5' } })] }), { animateNumbers: true });
  Motion.pipeline(el({ querySelectorAll: () => [el({ dataset: { grow: '3' } })] }), true);
  Motion.cards([card], { animate: true });
  Motion.rows([row], { animate: true });
  Motion.indicator(el());
  Motion.view(el());
  Motion.dialogIn(el());
  let closed = false;
  Motion.dialogOut(el(), () => { closed = true; });
  Motion.section([el()], true);
  Motion.section([el()], false);
  Motion.pulse(el());
  return Motion.leave(el()).then(() => {
    assert.ok(closed, 'dialogOut must call done');
    assert.ok(calls.includes('to') && calls.includes('fromTo') && calls.includes('timeline'), 'GSAP was actually used');
  });
});

test('hidden page and ?still skip animation and set final values', () => {
  for (const opts of [{ hidden: true }, { search: '?still' }]) {
    const { Motion, calls } = load(opts);
    const num = el({ dataset: { count: '7' } });
    Motion.stats(el({ querySelectorAll: () => [num] }), { animateNumbers: true });
    assert.strictEqual(num.textContent, 7);
    assert.deepStrictEqual(calls.filter(c => c !== 'set'), [], JSON.stringify(opts));
  }
});

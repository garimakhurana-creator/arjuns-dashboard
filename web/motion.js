// GSAP choreography for the hiring desk. Every function degrades to setting
// the final state instantly when GSAP is unavailable or the viewer prefers
// reduced motion, so the app never depends on animation to work.
(function () {
  const g = window.gsap;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ?still renders the final state with no motion (for screenshots and print).
  const still = /[?&]still(?:[=&]|$)/.test(location.search);
  const on = Boolean(g) && !reduced && !still;
  // Animate only when someone can see it; hidden tabs pause animation frames,
  // so a hidden page gets the final state straight away.
  const live = () => on && !document.hidden;
  if (g && window.SplitText) g.registerPlugin(window.SplitText);

  // Safety net: if the browser stops giving animation frames (hidden or
  // throttled tab), jump each tween to its end so content never stays invisible.
  const settle = t => {
    const ms = ((t.delay ? t.delay() : 0) + (t.totalDuration ? t.totalDuration() : 1)) * 1000 + 700;
    setTimeout(() => { if (t.progress() < 1) t.progress(1); }, ms);
    return t;
  };
  const G = g && {
    to: (...a) => settle(g.to(...a)),
    from: (...a) => settle(g.from(...a)),
    fromTo: (...a) => settle(g.fromTo(...a)),
    set: (...a) => g.set(...a),
    timeline: (...a) => g.timeline(...a),
  };

  const EASE = 'power3.out';
  const ringLen = r => 2 * Math.PI * r;

  // Sets a ring's progress. Animated rings sweep from empty.
  function setRing(circle, pct, { animate = true, delay = 0 } = {}) {
    if (!circle) return;
    const r = Number(circle.getAttribute('r'));
    const len = ringLen(r);
    const target = len * (1 - Math.max(0, Math.min(100, pct)) / 100);
    circle.style.strokeDasharray = `${len}`;
    if (live() && animate) {
      G.fromTo(circle, { strokeDashoffset: len }, { strokeDashoffset: target, duration: 1.2, delay, ease: 'power2.out' });
    } else {
      circle.style.strokeDashoffset = `${target}`;
    }
  }

  function countUp(el, value, { delay = 0, duration = 1.1 } = {}) {
    el.textContent = value;
    if (!live()) return;
    const obj = { v: 0 };
    G.to(obj, { v: value, duration, delay, ease: 'power2.out', onStart: () => { el.textContent = 0; }, onUpdate: () => { el.textContent = Math.round(obj.v); } });
  }

  const Motion = {
    enabled: on,
    setRing,
    countUp,

    intro() {
      if (!live()) return;
      const tl = G.timeline({ defaults: { ease: EASE } });
      tl.from('.top .brand', { y: -10, opacity: 0, duration: .6 })
        .from('.tabs', { y: -10, opacity: 0, duration: .6 }, '<.08')
        .from('.hero .eyebrow', { y: 8, opacity: 0, duration: .5 }, '<.1');
      const title = document.querySelector('.hero-title');
      if (window.SplitText && title) {
        const split = new window.SplitText(title, { type: 'words', wordsClass: 'w' });
        tl.from(split.words, { yPercent: 60, opacity: 0, rotate: 2, duration: .9, stagger: .06 }, '<.05');
      } else {
        tl.from('.hero-title', { y: 18, opacity: 0, duration: .8 }, '<.05');
      }
      tl.from('.hero-sub, .hero-principle', { y: 10, opacity: 0, duration: .6, stagger: .08 }, '-=.5')
        .from('.pipeline', { y: 16, opacity: 0, duration: .7 }, '-=.35')
        .from('.upload', { y: 16, opacity: 0, duration: .7 }, '-=.5');
      settle(tl);
    },

    // Re-types the hero sub-line when the numbers change.
    // Content is set immediately; the animation is only a flourish on top.
    swapText(el, html) {
      if (el.innerHTML === html) return;
      el.innerHTML = html;
      if (live()) G.fromTo(el, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .45, ease: EASE, clearProps: 'transform,opacity' });
    },

    stats(container, { animateNumbers }) {
      container.querySelectorAll('[data-count]').forEach((el, i) => {
        const v = Number(el.dataset.count);
        if (animateNumbers) countUp(el, v, { delay: .1 + i * .06 });
        else el.textContent = v;
      });
      if (live() && animateNumbers) G.from(container.querySelectorAll('.stat'), { y: 10, opacity: 0, duration: .6, stagger: .06, ease: EASE });
    },

    pipeline(bar, animate) {
      const segs = bar.querySelectorAll('.seg-fill');
      segs.forEach(s => { s.style.flexGrow = live() && animate ? 0 : s.dataset.grow; });
      if (live() && animate) G.to(segs, { flexGrow: i => Number(segs[i].dataset.grow), duration: 1.1, ease: 'power3.inOut', stagger: .08 });
    },

    // Cards: stagger in, then sweep rings and grow rubric bars.
    cards(nodes, { animate }) {
      nodes.forEach((card, i) => {
        const pct = Number(card.dataset.match || 0);
        setRing(card.querySelector('.ring-fg'), pct, { animate, delay: live() && animate ? .25 + i * .08 : 0 });
        card.querySelectorAll('.bar i').forEach(bar => {
          const w = Number(bar.dataset.w || 0);
          if (live() && animate) G.fromTo(bar, { width: '0%' }, { width: `${w}%`, duration: 1, delay: .35 + i * .08, ease: 'power2.out' });
          else bar.style.width = `${w}%`;
        });
      });
      if (live() && animate && nodes.length) {
        G.from(nodes, { y: 26, opacity: 0, duration: .75, stagger: .08, ease: EASE, clearProps: 'transform,opacity' });
      }
    },

    rows(nodes, { animate }) {
      nodes.forEach((row, i) => setRing(row.querySelector('.ring-fg'), Number(row.dataset.match || 0), { animate, delay: live() && animate ? .1 + Math.min(i, 12) * .04 : 0 }));
      if (live() && animate && nodes.length) {
        G.from(nodes.slice(0, 16), { y: 12, opacity: 0, duration: .5, stagger: .035, ease: EASE, clearProps: 'transform,opacity' });
      }
    },

    tableRows(tbody) {
      if (!live()) return;
      G.from([...tbody.querySelectorAll('tr:not([hidden])')].slice(0, 30), { opacity: 0, y: 6, duration: .35, stagger: .015, ease: 'power1.out', clearProps: 'all' });
    },

    // Slides the tab pill under the active tab.
    indicator(tab, instant) {
      const ind = document.querySelector('.tab-indicator');
      if (!ind || !tab) return;
      const x = tab.offsetLeft - 4;
      const w = tab.offsetWidth;
      if (live() && !instant) G.to(ind, { x, width: w, duration: .5, ease: 'power3.inOut' });
      else { ind.style.width = `${w}px`; ind.style.transform = `translateX(${x}px)`; }
    },

    view(section) {
      if (live()) G.fromTo(section, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .45, ease: EASE, clearProps: 'transform' });
    },

    dialogIn(dialog) {
      if (!live()) return;
      G.fromTo(dialog, { y: 40, opacity: 0, scale: .985 }, { y: 0, opacity: 1, scale: 1, duration: .55, ease: 'expo.out', clearProps: 'transform' });
    },
    dialogOut(dialog, done) {
      if (!live()) return done();
      let finished = false;
      const finish = () => { if (finished) return; finished = true; done(); G.set(dialog, { clearProps: 'all' }); };
      setTimeout(finish, 400);
      G.to(dialog, { y: 24, opacity: 0, duration: .25, ease: 'power2.in', onComplete: finish });
    },

    // Opens or closes a Review section's body elements.
    section(bodies, open) {
      if (!live()) { bodies.forEach(el => (el.hidden = !open)); return; }
      if (open) {
        bodies.forEach(el => (el.hidden = false));
        G.fromTo(bodies, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: .4, stagger: .05, ease: EASE, clearProps: 'transform,opacity' });
      } else {
        G.to(bodies, { opacity: 0, y: -6, duration: .2, ease: 'power1.in', onComplete: () => {
          bodies.forEach(el => (el.hidden = true));
          G.set(bodies, { clearProps: 'transform,opacity' });
        } });
      }
    },

    // Row leaving the list (reconsider / reject) before the list re-renders.
    leave(node) {
      return new Promise(resolve => {
        if (!live() || !node) return resolve();
        setTimeout(resolve, 600); // never block the list refresh on the animation
        G.to(node, { x: 24, opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, duration: .35, ease: 'power2.in', onComplete: resolve });
      });
    },

    pulse(el) {
      if (live() && el) G.fromTo(el, { scale: 1 }, { scale: 1.18, duration: .18, yoyo: true, repeat: 1, ease: 'power1.inOut' });
    },
  };

  window.Motion = Motion;
})();

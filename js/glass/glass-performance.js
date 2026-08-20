/*
 * Liquid Glass — Performance Manager
 * ---------------------------------------------------------------------------
 * Spec §35-§42.
 *
 * The hard rule from §41: when the page gets slow we shed *optical extras*, in
 * a fixed order, and we never fall back to "ordinary frosted glass".
 *
 *     dynamic light -> chromatic aberration -> animation
 *                   -> distortion -> background animation
 *
 * Tiers, driven by a rolling FPS average (§41):
 *
 *     > 55      full
 *     45 - 55   reduced motion
 *     35 - 45   reduced distortion
 *     < 35      minimal — few active surfaces, still glass
 *
 * Also owns the viewport budget (§36, §37): surfaces outside the viewport get
 * their refraction released, so a long archive page is not paying for eighty
 * displacement filters at once.
 */

(function () {
  'use strict';

  var TIERS = ['full', 'motion', 'distortion', 'minimal'];

  /* §36 — how many surfaces may hold a refraction filter at once. */
  var BUDGET = { desktop: 8, mobile: 3 };

  var QUALITY = {
    full:       { refraction: 1.00, aberration: 1.00 },
    motion:     { refraction: 1.00, aberration: 1.00 },
    distortion: { refraction: 0.55, aberration: 0.35 },
    minimal:    { refraction: 0.28, aberration: 0.00 }
  };

  var mqSmall = window.matchMedia('(max-width: 900px)');
  var mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var tier = 'full';
  var samples = [];
  var SAMPLE_N = 45;
  var running = false;
  var lastTime = 0;
  var settleUntil = 0;

  function budget() {
    return mqSmall.matches ? BUDGET.mobile : BUDGET.desktop;
  }

  function applyTier(next) {
    if (next === tier) return;
    tier = next;

    var root = document.documentElement;
    TIERS.forEach(function (t) { root.classList.remove('glass-tier-' + t); });
    root.classList.add('glass-tier-' + tier);

    /* §41 degradation order is expressed as data attributes the CSS keys off,
       so shedding an effect never means rewriting a rule. */
    var idx = TIERS.indexOf(tier);
    root.setAttribute('data-glass-light', idx >= 1 ? 'off' : 'on');
    root.setAttribute('data-glass-motion', idx >= 1 ? 'reduced' : 'full');
    root.setAttribute('data-glass-bg', idx >= 3 ? 'static' : 'animated');

    if (window.GlassCore) {
      window.GlassCore.setQuality(QUALITY[tier]);
      window.GlassCore.refreshAll();
    }

    document.dispatchEvent(new CustomEvent('glass:tier', { detail: { tier: tier } }));
  }

  function tierFromFps(fps) {
    if (fps > 55) return 'full';
    if (fps > 45) return 'motion';
    if (fps > 35) return 'distortion';
    return 'minimal';
  }

  function sample(now) {
    if (!running) return;

    if (lastTime) {
      var dt = now - lastTime;
      /* Ignore absurd deltas: a backgrounded tab is not a slow tab. */
      if (dt > 0 && dt < 400) {
        samples.push(1000 / dt);
        if (samples.length > SAMPLE_N) samples.shift();
      }
    }
    lastTime = now;

    if (samples.length >= SAMPLE_N && now > settleUntil) {
      var sum = 0;
      for (var i = 0; i < samples.length; i++) sum += samples[i];
      var fps = sum / samples.length;

      var next = tierFromFps(fps);
      /* Only ever recover one step at a time, and give the new tier a moment
         to actually take effect before judging it again. */
      var cur = TIERS.indexOf(tier);
      var want = TIERS.indexOf(next);
      if (want > cur) applyTier(TIERS[cur + 1]);
      else if (want < cur) applyTier(TIERS[cur - 1]);

      samples.length = 0;
      settleUntil = now + 1200;
    }

    requestAnimationFrame(sample);
  }

  function start() {
    if (running) return;
    running = true;
    lastTime = 0;
    samples.length = 0;
    requestAnimationFrame(sample);
  }

  function stop() {
    running = false;
  }

  /* Stop measuring while the tab is hidden — rAF stalls there and the
     resulting garbage samples would demote the whole page. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else { settleUntil = performance.now() + 1500; start(); }
  });

  /* ---------------------------------------------------------------------
     Viewport budget (§37)
     --------------------------------------------------------------------- */

  var offscreen = new WeakSet();

  var io = window.IntersectionObserver
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var element = entry.target;
          if (entry.isIntersecting) {
            if (offscreen.has(element)) {
              offscreen.delete(element);
              element.classList.remove('glass--dormant');
              if (window.GlassCore) window.GlassCore.updateGlass(element);
            }
          } else if (!offscreen.has(element)) {
            offscreen.add(element);
            element.classList.add('glass--dormant');
            /* Release the filter, keep the tint: still glass, costs nothing. */
            element.style.removeProperty('--g-filter');
          }
        });
      }, { rootMargin: '240px 0px' })
    : null;

  function observe(element) {
    if (io) io.observe(element);
  }

  function unobserve(element) {
    if (io) io.unobserve(element);
    offscreen.delete(element);
  }

  function boot() {
    applyTierInitial();
    start();
  }

  function applyTierInitial() {
    var root = document.documentElement;
    /* Mobile starts one tier down (§42): the glass stays, the extras do not. */
    var initial = mqSmall.matches ? 'motion' : 'full';
    if (mqMotion.matches) initial = 'motion';

    root.classList.add('glass-tier-' + initial);
    tier = initial;
    root.setAttribute('data-glass-light', initial === 'full' ? 'on' : 'off');
    root.setAttribute('data-glass-motion', initial === 'full' ? 'full' : 'reduced');
    root.setAttribute('data-glass-bg', 'animated');
    if (window.GlassCore) window.GlassCore.setQuality(QUALITY[initial]);
  }

  mqSmall.addEventListener('change', function () {
    samples.length = 0;
    settleUntil = performance.now() + 1000;
    applyTier(mqSmall.matches ? 'motion' : 'full');
  });

  window.GlassPerformance = {
    get tier() { return tier; },
    get budget() { return budget(); },
    observe: observe,
    unobserve: unobserve,
    isDormant: function (element) { return offscreen.has(element); },
    start: start,
    stop: stop,
    /* Exposed for the PoC page so a tier can be forced by hand. */
    force: function (next) {
      if (TIERS.indexOf(next) === -1) return;
      stop();
      applyTier(next);
    },
    resume: function () { start(); },
    TIERS: TIERS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

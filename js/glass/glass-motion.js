/*
 * Liquid Glass — Motion & Interaction
 * ---------------------------------------------------------------------------
 * Spec §13 (dynamic light), §14 (viscosity), §15 (magnetic), §16 (morphing),
 * §43 (touch), §44 (reduced motion), §46 (scroll edge effect), §49 (card hover).
 *
 * The forbidden interaction is `transform: translateY(-10px)` on hover (§49).
 * What happens instead:
 *
 *     pointer moves
 *         -> specular highlight follows      (--g-mx / --g-my)
 *         -> surface leans 1-2px toward it   (magnetic, §15)
 *         -> the bezel deforms under it      (live displacement, §14)
 *     pointer leaves
 *         -> everything springs back slowly  (viscous return)
 *
 * All of it is written as CSS custom properties inside a single rAF, never as
 * layout-affecting DOM work (§39, §40).
 */

(function () {
  'use strict';

  var mqHover = window.matchMedia('(hover: hover) and (pointer: fine)');
  var mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Pointer offset is quantised before it triggers a filter rebuild — without
     this every mouse pixel would regenerate a displacement map. */
  var LIVE_GRID = 12;

  var target = null;         /* surface currently under the pointer */
  var deformed = null;       /* surface currently holding the live filter */
  var lastGx = null;
  var lastGy = null;

  var pending = null;
  var frame = 0;

  function motionAllowed() {
    if (mqMotion.matches) return false;
    return document.documentElement.getAttribute('data-glass-motion') !== 'off';
  }

  function lightAllowed() {
    return document.documentElement.getAttribute('data-glass-light') !== 'off';
  }

  /* Magnetic pull, capped hard at 2px (§15: "严禁大幅移动"). */
  function magnet(element, nx, ny) {
    if (!motionAllowed() || !element.classList.contains('glass--interactive')) {
      element.style.removeProperty('--g-pull-x');
      element.style.removeProperty('--g-pull-y');
      return;
    }
    var limit = 2;
    element.style.setProperty('--g-pull-x', (nx * limit).toFixed(2) + 'px');
    element.style.setProperty('--g-pull-y', (ny * limit).toFixed(2) + 'px');
  }

  function flush() {
    frame = 0;
    var job = pending;
    pending = null;
    if (!job) return;

    var element = job.element;
    if (!element.isConnected) return;

    /* Highlight position, in percent of the surface (§13). */
    element.style.setProperty('--g-mx', job.px.toFixed(1) + '%');
    element.style.setProperty('--g-my', job.py.toFixed(1) + '%');

    magnet(element, job.nx, job.ny);

    /* Bezel deformation (§6, §14) — only when the tier still allows it and
       only for one surface at a time. */
    if (!window.GlassCore) return;

    var gx = Math.round(job.ox / LIVE_GRID) * LIVE_GRID;
    var gy = Math.round(job.oy / LIVE_GRID) * LIVE_GRID;

    if (deformed === element && gx === lastGx && gy === lastGy) return;

    if (deformed && deformed !== element) {
      window.GlassCore.undeform(deformed);
      deformed = null;
    }

    if (!motionAllowed()) return;
    if (window.GlassPerformance && window.GlassPerformance.tier === 'minimal') return;

    if (window.GlassCore.deform(element, job.ox, job.oy)) {
      deformed = element;
      lastGx = gx;
      lastGy = gy;
    }
  }

  function releaseTarget() {
    if (target) {
      target.style.removeProperty('--g-pull-x');
      target.style.removeProperty('--g-pull-y');
      target = null;
    }
    if (deformed && window.GlassCore) {
      window.GlassCore.undeform(deformed);
      deformed = null;
      lastGx = lastGy = null;
    }
  }

  function onPointerMove(ev) {
    if (!mqHover.matches) return;

    var element = ev.target instanceof Element ? ev.target.closest('.glass') : null;
    if (!element || element.classList.contains('glass--dormant')) {
      releaseTarget();
      return;
    }

    if (target && target !== element) {
      target.style.removeProperty('--g-pull-x');
      target.style.removeProperty('--g-pull-y');
    }
    target = element;

    var rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    var lx = ev.clientX - rect.left;
    var ly = ev.clientY - rect.top;

    pending = {
      element: element,
      px: (lx / rect.width) * 100,
      py: (ly / rect.height) * 100,
      /* Offset from the centre, element px — drives the lens shift. */
      ox: lx - rect.width / 2,
      oy: ly - rect.height / 2,
      /* Normalised -1..1 for the magnetic lean. */
      nx: (lx / rect.width) * 2 - 1,
      ny: (ly / rect.height) * 2 - 1
    };

    if (!frame) frame = requestAnimationFrame(flush);
    if (!lightAllowed()) {
      element.style.removeProperty('--g-mx');
      element.style.removeProperty('--g-my');
    }
  }

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', releaseTarget);
  document.addEventListener('blur', releaseTarget);
  window.addEventListener('scroll', function () {
    /* A surface that scrolls out from under a stationary pointer would keep a
       stale deformation otherwise. */
    if (deformed) releaseTarget();
  }, { passive: true });

  /* ---------------------------------------------------------------------
     Touch: press / compress / spring back (§43)
     --------------------------------------------------------------------- */

  function onDown(ev) {
    var element = ev.target instanceof Element ? ev.target.closest('.glass--interactive') : null;
    if (!element) return;
    element.classList.add('glass--pressed');
  }

  function onUp() {
    var pressed = document.querySelectorAll('.glass--pressed');
    for (var i = 0; i < pressed.length; i++) {
      pressed[i].classList.remove('glass--pressed');
    }
  }

  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('pointercancel', onUp, { passive: true });

  /* ---------------------------------------------------------------------
     Scroll edge effect (§46)
     ---------------------------------------------------------------------
     Not "navbar opacity up". As content arrives underneath the bar, the bar
     separates from the page: its tint firms up, its bezel tightens, and a
     dissolve gradient appears along its lower edge so text passing under it
     fades rather than colliding with it. --g-scroll-edge goes 0 -> 1 over the
     first 160px, and the CSS interpolates everything from that.
     --------------------------------------------------------------------- */

  var EDGE_RANGE = 160;
  var edgeFrame = 0;
  var lastEdge = -1;

  function writeEdge() {
    edgeFrame = 0;
    var y = window.scrollY || window.pageYOffset || 0;
    var t = Math.max(0, Math.min(1, y / EDGE_RANGE));
    var q = Math.round(t * 100) / 100;
    if (q === lastEdge) return;
    lastEdge = q;
    document.documentElement.style.setProperty('--g-scroll-edge', String(q));
    document.documentElement.classList.toggle('glass-scrolled', q > 0.02);
  }

  window.addEventListener('scroll', function () {
    if (!edgeFrame) edgeFrame = requestAnimationFrame(writeEdge);
  }, { passive: true });

  writeEdge();

  /* ---------------------------------------------------------------------
     Morphing (§16)
     ---------------------------------------------------------------------
     Butterfly opens its search dialog and mobile menu by toggling classes on
     <body> / <html>. Marking those moments lets the CSS run a stretch-and-
     settle morph instead of an opacity fade.
     --------------------------------------------------------------------- */

  function watchMorph() {
    var flags = [
      { selector: '#local-search, .search-dialog', cls: 'glass-morph-in' },
      { selector: '#sidebar-menus', cls: 'glass-morph-in' }
    ];

    new MutationObserver(function () {
      flags.forEach(function (flag) {
        var nodes = document.querySelectorAll(flag.selector);
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var open = node.classList.contains('open') ||
                     getComputedStyle(node).visibility === 'visible';
          node.classList.toggle(flag.cls, open);
        }
      });
    }).observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class', 'style']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchMorph);
  } else {
    watchMorph();
  }

  window.GlassMotion = {
    get target() { return target; },
    get deformed() { return deformed; },
    release: releaseTarget,
    EDGE_RANGE: EDGE_RANGE
  };
})();

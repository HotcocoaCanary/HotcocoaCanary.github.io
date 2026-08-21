/*
 * Liquid Glass — Motion & Interaction
 * ---------------------------------------------------------------------------
 * Spec §16 (morphing), §43 (touch), §44 (reduced motion), §46 (scroll edge).
 *
 * Pointer-tracked light, magnetic pull, hover scale and live bezel deformation
 * have been removed pending a redesign of the mouse interaction model.
 */

(function () {
  'use strict';

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
    release: function () {},
    EDGE_RANGE: EDGE_RANGE
  };
})();

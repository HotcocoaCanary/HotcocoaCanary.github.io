/*
 * Liquid Glass — Butterfly Adapter
 * ---------------------------------------------------------------------------
 * Spec §28 (Butterfly Adapter), §29 (do not fork Butterfly core), §26 (all
 * surfaces are glass), §38 (debounced resize).
 *
 * This is the only file that knows Butterfly exists. It maps theme selectors
 * onto glass weights, hands each element to GlassCore, and re-runs after PJAX.
 * Nothing here draws anything.
 *
 *     Butterfly .card-widget  ->  .glass .glass--medium
 *
 * Swapping the theme means rewriting SURFACES and nothing else.
 */

(function () {
  'use strict';

  /* §26 — the full inventory. Anything Butterfly renders as a panel is in
     here; there is no "glass card + normal card" split. */
  var SURFACES = [
    /* Clear / soft: chrome that floats over content. */
    ['#nav', 'glass--soft'],
    ['#rightside > div > button, #rightside > button', 'glass--soft glass--interactive'],
    ['#pagination .page-number, #pagination .extend', 'glass--soft glass--interactive'],
    ['.tag-cloud-list a', 'glass--soft glass--interactive'],
    ['#article-container .tag-list a', 'glass--soft glass--interactive'],
    ['#post .post-copyright', 'glass--soft'],
    ['#footer-wrap', 'glass--soft'],

    /* Regular: persistent side furniture (§48). */
    ['#aside-content .card-widget', 'glass--medium'],
    ['#card-toc, #toc-div', 'glass--medium'],
    ['#article-container .note', 'glass--medium'],

    /* Strong: the things you actually came to read. */
    ['#recent-posts .recent-post-item', 'glass--strong glass--interactive'],
    ['#post, #page, #archive, #tag, #category', 'glass--strong'],
    ['.relatedPosts .relatedPosts-list > div', 'glass--soft glass--interactive'],
    ['#archive .article-sort-item', 'glass--soft glass--interactive'],

    /* Dense: high-contrast inserts inside prose (§24, §25). */
    ['#article-container figure.highlight', 'glass--dense'],
    ['#article-container pre:not(figure.highlight pre)', 'glass--dense'],
    ['#article-container blockquote', 'glass--dense glass--quote'],
    ['#article-container .table-wrap', 'glass--dense glass--table'],

    /* Floating: transient overlays. */
    ['#local-search .search-dialog, .search-dialog', 'glass--floating'],
    ['#sidebar-menus', 'glass--floating'],
    ['#body-wrap .toggle-menu-dialog', 'glass--floating']
  ];

  var resizeObserver = window.ResizeObserver
    ? new ResizeObserver(function (entries) {
        entries.forEach(function (entry) { schedule(entry.target); });
      })
    : null;

  /* One rAF for however many surfaces asked to be re-measured. */
  var queue = new Set();
  var frame = 0;

  function schedule(element) {
    queue.add(element);
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var items = Array.from(queue);
      queue.clear();
      items.forEach(function (element) {
        if (!element.isConnected) {
          if (window.GlassCore) window.GlassCore.destroyGlass(element);
          if (window.GlassPerformance) window.GlassPerformance.unobserve(element);
          return;
        }
        if (window.GlassPerformance && window.GlassPerformance.isDormant(element)) return;
        if (window.GlassCore) window.GlassCore.updateGlass(element);
      });
    });
  }

  function tag() {
    if (!window.GlassCore) return;

    SURFACES.forEach(function (pair) {
      var nodes;
      try {
        nodes = document.querySelectorAll(pair[0]);
      } catch (err) {
        return;   /* a selector this Butterfly version no longer renders */
      }

      for (var i = 0; i < nodes.length; i++) {
        var element = nodes[i];
        if (element.classList.contains('glass')) continue;

        element.classList.add('glass');
        pair[1].split(' ').forEach(function (cls) {
          if (cls) element.classList.add(cls);
        });

        window.GlassCore.createGlass(element);
        if (window.GlassPerformance) window.GlassPerformance.observe(element);
        if (resizeObserver) resizeObserver.observe(element);
      }
    });
  }

  function boot() {
    document.documentElement.classList.add('glass-ready');
    tag();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Butterfly rewrites parts of the article after DOMContentLoaded — it wraps
     wide tables in .table-wrap and builds the TOC — so late passes catch the
     surfaces that did not exist at boot. */
  window.addEventListener('load', function () {
    tag();
    setTimeout(tag, 400);
  });

  ['pjax:complete', 'pjax:success'].forEach(function (evt) {
    document.addEventListener(evt, function () {
      if (window.GlassMotion) window.GlassMotion.release();
      tag();
      setTimeout(tag, 400);
    });
  });

  /* §38 — debounce, never regenerate per frame. */
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (window.GlassCore) {
        window.GlassCore.select();
        window.GlassCore.refreshAll();
      }
    }, 180);
  });

  /* Butterfly writes data-theme on <html> when the reader flips the switch. */
  new MutationObserver(function () {
    if (window.GlassCore) window.GlassCore.refreshAll();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  window.matchMedia('(prefers-reduced-transparency: reduce)')
    .addEventListener('change', function () {
      if (window.GlassCore) {
        window.GlassCore.select();
        window.GlassCore.refreshAll();
      }
    });

  window.liquidGlass = {
    retag: tag,
    refresh: function () { if (window.GlassCore) window.GlassCore.refreshAll(); },
    surfaces: SURFACES
  };
})();

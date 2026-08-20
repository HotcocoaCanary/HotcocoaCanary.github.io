/*
 * Liquid Glass — Core rendering system
 * ---------------------------------------------------------------------------
 * Spec §30 (Rendering Engine API), §31 (Renderer Interface), §32 (Progressive
 * Enhancement), §33 (Safari / Firefox), §11 (Chromatic Aberration).
 *
 * The point of this file is that nothing above it knows how the glass is
 * drawn. Butterfly talks to three functions:
 *
 *     createGlass(element, options)
 *     updateGlass(element, options)
 *     destroyGlass(element)
 *
 * Underneath, a renderer is chosen once from browser capability:
 *
 *     SvgGlassRenderer   real displacement refraction   (Chromium)
 *     CssGlassRenderer   edge ring + highlight, no warp (Safari / Firefox)
 *     FallbackRenderer   tint + border only             (no backdrop-filter)
 *
 * Swapping in a WebGL renderer later means adding a class here and nothing
 * else. Material parameters stay in CSS custom properties so theme flips and
 * media queries keep working without a JS round trip.
 */

(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  var SIZE_STEP = 8;     /* quantise sizes so a grid of cards shares a filter */
  var CACHE_LIMIT = 48;

  /* ---------------------------------------------------------------------
     Capability detection (§33 — never assume, always test)
     --------------------------------------------------------------------- */

  function backdropSupported() {
    if (!window.CSS || !CSS.supports) return false;
    return CSS.supports('backdrop-filter', 'blur(1px)') ||
           CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  }

  /* Only Chromium composites an SVG reference filter *inside* backdrop-filter.
     Safari and Firefox parse it and silently drop the whole declaration, so
     they must not be handed one. */
  function chromiumLike() {
    var uad = navigator.userAgentData;
    if (uad && uad.brands && uad.brands.length) {
      for (var i = 0; i < uad.brands.length; i++) {
        if (/Chromium/i.test(uad.brands[i].brand)) return true;
      }
      return false;
    }
    var ua = navigator.userAgent;
    /* CriOS / FxiOS / EdgiOS are WebKit wearing a costume. */
    if (/CriOS|FxiOS|EdgiOS/.test(ua)) return false;
    return /Chrome\/|Chromium\/|Edg\//.test(ua);
  }

  var mqTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
  var mqCoarse = window.matchMedia('(max-width: 900px)');

  /* ---------------------------------------------------------------------
     Shared SVG host
     --------------------------------------------------------------------- */

  var host = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('glass-filter-host');
    if (!host) {
      host = document.createElementNS(SVG_NS, 'svg');
      host.setAttribute('id', 'glass-filter-host');
      host.setAttribute('width', '0');
      host.setAttribute('height', '0');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;';
      host.appendChild(document.createElementNS(SVG_NS, 'defs'));
      document.body.appendChild(host);
    }
    return host;
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        node.setAttribute(k, String(attrs[k]));
      }
    }
    return node;
  }

  function setHref(node, url) {
    node.setAttribute('href', url);
    node.setAttributeNS(XLINK_NS, 'xlink:href', url);
  }

  /* ---------------------------------------------------------------------
     Filter construction
     ---------------------------------------------------------------------
     Without chromatic aberration the chain is simply

         feImage(map) -> feDisplacementMap(SourceGraphic)

     With it (§11) the backdrop is displaced three times at slightly
     different strengths and the R / G / B channels are recombined, which is
     what produces a faint coloured fringe on the bezel. Alpha is carried by
     the green pass only, so compositing the three does not triple it.
     --------------------------------------------------------------------- */

  function buildFilterChain(filter, map, aberration) {
    while (filter.firstChild) filter.removeChild(filter.firstChild);

    var feImage = el('feImage', {
      result: 'map',
      preserveAspectRatio: 'none'
    });
    setHref(feImage, map.url);
    filter.appendChild(feImage);

    if (!aberration || aberration <= 0.001) {
      filter.appendChild(el('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'map',
        scale: map.scale,
        xChannelSelector: 'R',
        yChannelSelector: 'G'
      }));
      return { feImage: feImage, scales: null };
    }

    /* R bends most, B least — the ordering glass actually has. */
    var spread = aberration;
    var scales = [
      map.scale * (1 + spread),
      map.scale,
      map.scale * (1 - spread)
    ];
    var channels = ['R', 'G', 'B'];
    /* Each pass keeps one colour channel and *keeps its alpha*.
       Dropping alpha on the R and B passes looks like the tidy thing to do —
       it stops the three alphas from stacking — but filter compositing works
       on premultiplied colour: an alpha of 0 multiplies that pass's channel
       to 0 before feComposite ever sees it. Zeroing alpha therefore deletes
       red and blue outright and every surface renders pure green.
       Keeping alpha is both correct and harmless: the backdrop is opaque, so
       the three alphas sum to 3 and clamp straight back to 1. */
    var keep = [
      /* red only */
      '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      /* green only */
      '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      /* blue only */
      '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
    ];

    for (var i = 0; i < 3; i++) {
      filter.appendChild(el('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'map',
        scale: scales[i],
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: 'd' + channels[i]
      }));
      filter.appendChild(el('feColorMatrix', {
        in: 'd' + channels[i],
        type: 'matrix',
        values: keep[i],
        result: 'c' + channels[i]
      }));
    }

    /* Additive recombination. */
    filter.appendChild(el('feComposite', {
      in: 'cR', in2: 'cG',
      operator: 'arithmetic',
      k1: 0, k2: 1, k3: 1, k4: 0,
      result: 'cRG'
    }));
    filter.appendChild(el('feComposite', {
      in: 'cRG', in2: 'cB',
      operator: 'arithmetic',
      k1: 0, k2: 1, k3: 1, k4: 0
    }));

    return { feImage: feImage, scales: scales };
  }

  function sizeFilter(filter, feImage, w, h) {
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', String(w));
    filter.setAttribute('height', String(h));
    feImage.setAttribute('x', '0');
    feImage.setAttribute('y', '0');
    feImage.setAttribute('width', String(w));
    feImage.setAttribute('height', String(h));
  }

  /* ---------------------------------------------------------------------
     Renderer interface (§31)
     --------------------------------------------------------------------- */

  function GlassRenderer() {}
  GlassRenderer.prototype.name = 'base';
  GlassRenderer.prototype.supports = function () { return false; };
  GlassRenderer.prototype.mount = function () {};
  GlassRenderer.prototype.update = function () {};
  GlassRenderer.prototype.destroy = function () {};

  /* ---- SVG: true edge refraction ------------------------------------- */

  function SvgGlassRenderer() {
    this.cache = new Map();   /* geometry key -> { id, node, uses } */
    this.held = new WeakMap();/* element -> geometry key */
    this.seq = 0;
  }
  SvgGlassRenderer.prototype = new GlassRenderer();
  SvgGlassRenderer.prototype.name = 'svg';

  SvgGlassRenderer.prototype.supports = function () {
    return backdropSupported() && chromiumLike() && !mqTransparency.matches;
  };

  SvgGlassRenderer.prototype.key = function (o) {
    return [o.w, o.h, o.radius, o.bezel, o.refraction,
            o.ior, o.edgeDepth, o.aberration].join('|');
  };

  SvgGlassRenderer.prototype.acquire = function (o) {
    var key = this.key(o);
    var hit = this.cache.get(key);
    if (hit) return hit;

    var map = window.GlassSDF.buildMap(o);
    if (!map) return null;

    var id = 'glass-f' + (++this.seq);
    var filter = el('filter', {
      id: id,
      filterUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB'
    });
    var chain = buildFilterChain(filter, map, o.aberration);
    sizeFilter(filter, chain.feImage, o.w, o.h);
    ensureHost().firstChild.appendChild(filter);

    var entry = { id: id, node: filter, uses: 0, key: key };
    this.cache.set(key, entry);
    this.purge();
    return entry;
  };

  SvgGlassRenderer.prototype.purge = function () {
    var cache = this.cache;
    if (cache.size <= CACHE_LIMIT) return;
    cache.forEach(function (entry, key) {
      if (cache.size <= CACHE_LIMIT) return;
      if (entry.uses <= 0) {
        entry.node.remove();
        cache.delete(key);
      }
    });
  };

  SvgGlassRenderer.prototype.release = function (element) {
    var key = this.held.get(element);
    if (!key) return;
    var entry = this.cache.get(key);
    if (entry) entry.uses--;
    this.held.delete(element);
  };

  SvgGlassRenderer.prototype.mount = function (element, options) {
    this.update(element, options);
  };

  SvgGlassRenderer.prototype.update = function (element, options) {
    var key = this.key(options);
    /* Early out only when the right filter is already applied. The viewport
       budget (§37) releases --g-filter directly when a surface scrolls
       off-screen, so a held key with an empty filter means "dormant, wake it
       back up" — not "already correct". */
    if (this.held.get(element) === key &&
        element.style.getPropertyValue('--g-filter')) {
      return;
    }

    this.release(element);
    var entry = this.acquire(options);
    if (!entry) {
      element.style.removeProperty('--g-filter');
      return;
    }
    entry.uses++;
    this.held.set(element, entry.key);
    element.style.setProperty('--g-filter', 'url(#' + entry.id + ')');
  };

  SvgGlassRenderer.prototype.destroy = function (element) {
    this.release(element);
    element.style.removeProperty('--g-filter');
  };

  /* Per-element live filter used by the pointer deformation (§13, §14).
     One node, reassigned — only ever a single element deforms at a time. */
  SvgGlassRenderer.prototype.LIVE_ID = 'glass-live';

  SvgGlassRenderer.prototype.ensureLive = function () {
    if (this.liveNode && this.liveNode.isConnected) return;
    this.liveNode = el('filter', {
      id: this.LIVE_ID,
      filterUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB'
    });
    this.liveChain = null;
    ensureHost().firstChild.appendChild(this.liveNode);
  };

  SvgGlassRenderer.prototype.live = function (element, options) {
    this.ensureLive();
    var map = window.GlassSDF.buildMap(options);
    if (!map) return false;

    var chain = buildFilterChain(this.liveNode, map, options.aberration);
    sizeFilter(this.liveNode, chain.feImage, options.w, options.h);
    element.style.setProperty('--g-filter', 'url(#' + this.LIVE_ID + ')');
    return true;
  };

  SvgGlassRenderer.prototype.restore = function (element) {
    var key = this.held.get(element);
    var entry = key ? this.cache.get(key) : null;
    if (entry) {
      element.style.setProperty('--g-filter', 'url(#' + entry.id + ')');
    } else {
      element.style.removeProperty('--g-filter');
    }
  };

  /* ---- CSS: edge ring, no displacement (§34) -------------------------- */

  function CssGlassRenderer() {}
  CssGlassRenderer.prototype = new GlassRenderer();
  CssGlassRenderer.prototype.name = 'css';
  CssGlassRenderer.prototype.supports = function () {
    return backdropSupported();
  };
  /* Everything this renderer needs is already in the stylesheet, keyed off
     the .glass-css class the core puts on <html>. It only has to make sure
     no stale reference filter is left behind. */
  CssGlassRenderer.prototype.mount = function (element) {
    element.style.removeProperty('--g-filter');
  };
  CssGlassRenderer.prototype.update = CssGlassRenderer.prototype.mount;
  CssGlassRenderer.prototype.destroy = CssGlassRenderer.prototype.mount;

  /* ---- Nothing at all ------------------------------------------------- */

  function FallbackRenderer() {}
  FallbackRenderer.prototype = new GlassRenderer();
  FallbackRenderer.prototype.name = 'fallback';
  FallbackRenderer.prototype.supports = function () { return true; };
  FallbackRenderer.prototype.mount = function (element) {
    element.style.removeProperty('--g-filter');
  };
  FallbackRenderer.prototype.update = FallbackRenderer.prototype.mount;
  FallbackRenderer.prototype.destroy = FallbackRenderer.prototype.mount;

  /* ---------------------------------------------------------------------
     Renderer selection
     --------------------------------------------------------------------- */

  var renderers = [new SvgGlassRenderer(), new CssGlassRenderer(), new FallbackRenderer()];
  var active = null;

  function pick() {
    var forced = document.documentElement.getAttribute('data-glass-renderer');
    for (var i = 0; i < renderers.length; i++) {
      if (forced && renderers[i].name === forced) return renderers[i];
    }
    for (var j = 0; j < renderers.length; j++) {
      if (renderers[j].supports()) return renderers[j];
    }
    return renderers[renderers.length - 1];
  }

  function renderer() {
    if (!active) select();
    return active;
  }

  function select() {
    active = pick();
    var root = document.documentElement;
    root.classList.remove('glass-svg', 'glass-css', 'glass-fallback');
    root.classList.add('glass-' + active.name);
    root.classList.toggle('glass-refract', active.name === 'svg');
    return active;
  }

  /* ---------------------------------------------------------------------
     Options resolution — CSS custom properties are the source of truth
     --------------------------------------------------------------------- */

  function num(style, prop, fallback) {
    var v = parseFloat(style.getPropertyValue(prop));
    return isNaN(v) ? fallback : v;
  }

  /* Quality is turned down by the performance manager (§41) and by the mobile
     profile (§42). It scales refraction and aberration but never removes the
     glass — degrading to plain frosted glass is forbidden by §41. */
  var quality = { refraction: 1, aberration: 1 };

  function setQuality(next) {
    quality.refraction = next.refraction != null ? next.refraction : quality.refraction;
    quality.aberration = next.aberration != null ? next.aberration : quality.aberration;
  }

  function resolve(element, overrides) {
    var rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 16) return null;

    var w = Math.ceil(rect.width / SIZE_STEP) * SIZE_STEP;
    var h = Math.ceil(rect.height / SIZE_STEP) * SIZE_STEP;

    var cs = getComputedStyle(element);
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius > Math.min(w, h) / 2) radius = Math.min(w, h) / 2;

    var o = {
      w: w,
      h: h,
      radius: radius,
      refraction: num(cs, '--glass-refraction', 26) * quality.refraction,
      bezel: num(cs, '--glass-bezel-width', 26),
      ior: num(cs, '--glass-ior', 1.485),
      edgeDepth: num(cs, '--glass-edge-depth', 3),
      aberration: num(cs, '--glass-chromatic', 0) * quality.aberration,
      offsetX: 0,
      offsetY: 0,
      rect: rect
    };

    if (overrides) {
      for (var k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) o[k] = overrides[k];
      }
    }
    return o;
  }

  /* ---------------------------------------------------------------------
     Public API (§30)
     --------------------------------------------------------------------- */

  var mounted = new Set();

  function createGlass(element, overrides) {
    if (!element) return;
    mounted.add(element);
    var o = resolve(element, overrides);
    if (!o) return;
    renderer().mount(element, o);
  }

  function updateGlass(element, overrides) {
    if (!element || !mounted.has(element)) return;
    var o = resolve(element, overrides);
    if (!o) return;
    renderer().update(element, o);
  }

  function destroyGlass(element) {
    if (!element) return;
    mounted.delete(element);
    renderer().destroy(element);
  }

  function refreshAll() {
    mounted.forEach(function (element) {
      if (element.isConnected) updateGlass(element);
      else destroyGlass(element);
    });
  }

  /* Pointer-tracked deformation, delegated to the renderer when it can do it. */
  function deform(element, offsetX, offsetY) {
    var r = renderer();
    if (!r.live || !mounted.has(element)) return false;
    var o = resolve(element, { offsetX: offsetX, offsetY: offsetY });
    if (!o) return false;
    return r.live(element, o);
  }

  function undeform(element) {
    var r = renderer();
    if (r.restore && element) r.restore(element);
  }

  window.GlassCore = {
    createGlass: createGlass,
    updateGlass: updateGlass,
    destroyGlass: destroyGlass,
    refreshAll: refreshAll,
    deform: deform,
    undeform: undeform,
    select: select,
    setQuality: setQuality,
    get quality() { return quality; },
    get renderer() { return renderer(); },
    get mounted() { return mounted; },
    capabilities: {
      backdrop: backdropSupported,
      chromium: chromiumLike,
      get reducedTransparency() { return mqTransparency.matches; },
      get coarse() { return mqCoarse.matches; }
    },
    SIZE_STEP: SIZE_STEP
  };

  if (document.body) ensureHost();
  else document.addEventListener('DOMContentLoaded', ensureHost);

  select();
})();

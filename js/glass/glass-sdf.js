/*
 * Liquid Glass — Signed Distance Field / Displacement Vector Field
 * ---------------------------------------------------------------------------
 * Spec §7 (SDF / Vector Field) and §8 (Displacement Map).
 *
 * A rounded-rectangle SDF gives us, for every pixel, the distance to the
 * nearest edge. The gradient of that field is the surface normal. Pushing the
 * backdrop along that normal is refraction — and because the field is flat in
 * the interior, the push decays to zero away from the rim:
 *
 *     interior : displacement ~ 0     (text stays readable)
 *     edge     : displacement ^        (the glass looks thick)
 *
 * The XY vector is encoded into the R/G channels around the neutral 128/128,
 * exactly as §8 requires, so the same map drives an SVG feDisplacementMap or
 * a WebGL UV offset without translation.
 *
 * Exposes: window.GlassSDF.buildMap(options) -> { url, scale } | null
 */

(function () {
  'use strict';

  /* The field is smooth, so the map can be generated well below element
     resolution and stretched back up by feImage. 192px keeps a full-width
     article card around a couple of milliseconds. */
  var MAX_MAP = 192;

  function smoothStep(a, b, t) {
    t = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* Negative inside, zero on the edge, positive outside. */
  function roundedRectSDF(x, y, hw, hh, r) {
    var qx = Math.abs(x) - hw + r;
    var qy = Math.abs(y) - hh + r;
    var mx = Math.max(qx, 0);
    var my = Math.max(qy, 0);
    return Math.min(Math.max(qx, qy), 0) + Math.sqrt(mx * mx + my * my) - r;
  }

  /* Index of refraction -> relative bend strength.
     Normalised so the middle of the plausible glass range (§10, 1.45-1.52)
     lands near 1.0. This is visual fitting, not physics. */
  function iorFactor(ior) {
    if (!isFinite(ior) || ior <= 1) return 1;
    return (ior - 1) / 0.485;
  }

  /*
   * options:
   *   w, h          element size in px
   *   radius        border radius in px
   *   bezel         width of the refracting band in px  (--glass-bezel-width)
   *   refraction    peak displacement in px             (--glass-refraction)
   *   ior           index of refraction                 (--glass-ior)
   *   edgeDepth     falloff exponent, higher = tighter  (--glass-edge-depth)
   */
  function buildMap(options) {
    var w = options.w;
    var h = options.h;
    if (!(w > 0 && h > 0)) return null;

    var k = Math.min(1, MAX_MAP / Math.max(w, h));
    var mw = Math.max(8, Math.round(w * k));
    var mh = Math.max(8, Math.round(h * k));

    var hw = w / 2;
    var hh = h / 2;
    var r = Math.max(0, Math.min(options.radius || 0, Math.min(hw, hh)));

    var bezel = Math.max(2, Math.min(options.bezel || 24, Math.min(hw, hh)));
    var strength = (options.refraction || 0) * iorFactor(options.ior || 1.485);
    if (strength <= 0.01) return null;

    var depth = Math.max(1, options.edgeDepth || 3);

    /* Bevel cross-section.
       -------------------------------------------------------------------
       This used to be pow(smoothstep(-bezel, 0, d), depth). smoothstep is an
       S-curve, so its slope is zero at *both* ends -- including at the rim.
       Refraction follows the slope of the glass surface, so a profile that
       flattens at the rim describes a chamfer: a flat cut running parallel to
       the face, which is exactly how the edge was reading. A real bevel is
       curved and its slope is greatest right at the rim, where the surface
       turns over.

       So the band is a circular cross-section instead:

           t(u) = u * sqrt((1 - K) / (1 - u^2 * K))

       with u running 0 at the inner edge of the band to 1 at the rim. t(0)=0
       and t(1)=1 as before, but the slope at the rim is 1 + K/(1-K) rather
       than 0 -- the displacement keeps climbing all the way out instead of
       levelling off. K comes from --glass-edge-depth so the existing per-
       weight tuning still means "how tightly the edge turns over".

       u is linear in d, not another smoothstep: nesting one would put a zero
       slope back at the rim through the chain rule and undo the whole point.
       The inner end is gated separately below, where t is near zero anyway. */
    var lensK = 1 - 1 / (1 + depth * depth);
    var lensNorm = Math.sqrt(1 - lensK);
    var innerGate = bezel * 0.35;

    var offs = new Float32Array(mw * mh * 2);
    var peak = 0;
    var e = 1;  /* gradient probe, in element px */

    for (var j = 0; j < mh; j++) {
      var py = ((j + 0.5) / mh) * h - hh;
      for (var i = 0; i < mw; i++) {
        var px = ((i + 0.5) / mw) * w - hw;

        var d = roundedRectSDF(px, py, hw, hh, r);

        /* 0 deep inside -> 1 at the rim, along the bevel's curve. */
        var u = (d + bezel) / bezel;
        if (u <= 0) continue;
        if (u > 1) u = 1;

        var t = u * lensNorm / Math.sqrt(1 - u * u * lensK);

        /* Ease the inner end on. A linear u starts with a non-zero slope, and
           left bare that draws a faint line where the band begins. Gating
           only the inner third leaves the rim untouched. */
        if (d + bezel < innerGate) {
          var g = (d + bezel) / innerGate;
          t *= g * g * (3 - 2 * g);
        }
        if (t <= 0.0005) continue;

        /* Outward normal = gradient of the SDF.
           Central-differenced rather than taken analytically, deliberately.
           The closed form is one evaluation per pixel instead of five, but
           the rounded-rect field has a genuine ridge running diagonally in
           from each corner where two edges are equidistant, and the exact
           gradient flips through 90 degrees across it. Sampling +/-1px blurs
           that flip into a smooth rotation; the exact version creases every
           corner, which is where the displacement is strongest and any
           artefact is most visible. Measured saving was 1-2ms per page load
           -- buildMap is cached per geometry and runs a handful of times, not
           per frame -- so the trade is not worth taking. */
        var gx = roundedRectSDF(px + e, py, hw, hh, r) -
                 roundedRectSDF(px - e, py, hw, hh, r);
        var gy = roundedRectSDF(px, py + e, hw, hh, r) -
                 roundedRectSDF(px, py - e, hw, hh, r);
        var len = Math.sqrt(gx * gx + gy * gy);
        if (len < 1e-6) continue;

        /* Sample from further inside: the rim shows a compressed image of the
           interior, which is what a thick bevel does to what is behind it. */
        var amt = t * strength;
        var ox = -(gx / len) * amt;
        var oy = -(gy / len) * amt;

        var p = (j * mw + i) * 2;
        offs[p] = ox;
        offs[p + 1] = oy;
        if (Math.abs(ox) > peak) peak = Math.abs(ox);
        if (Math.abs(oy) > peak) peak = Math.abs(oy);
      }
    }

    if (peak < 0.01) return null;

    var canvas = document.createElement('canvas');
    canvas.width = mw;
    canvas.height = mh;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(mw, mh);
    var data = img.data;

    /* scale = 2*peak so channel 0.5 +/- off/(2*peak) round-trips exactly:
       feDisplacementMap reads (C - 0.5) * scale. */
    var scale = peak * 2;
    for (var n = 0, q = 0; n < data.length; n += 4, q += 2) {
      data[n]     = (0.5 + offs[q]     / scale) * 255;   /* R -> X */
      data[n + 1] = (0.5 + offs[q + 1] / scale) * 255;   /* G -> Y */
      data[n + 2] = 0;
      data[n + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    return { url: canvas.toDataURL(), scale: scale };
  }

  window.GlassSDF = {
    buildMap: buildMap,
    roundedRectSDF: roundedRectSDF,
    iorFactor: iorFactor,
    MAX_MAP: MAX_MAP
  };
})();

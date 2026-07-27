/* ==========================================================================
   voyage.js -- Mission to Anywhere (/voyage/).
   --------------------------------------------------------------------------
   Page runtime. All the math lives in voyage-astro.js (window.VoyageAstro);
   the star + exoplanet catalog is the generated voyage-data.js
   (window.VOYAGE_DATA, HYG CC BY-SA + NASA Exoplanet Archive). This file
   owns one full-screen canvas: a 3D solar system (real JPL positions for
   today), a real star field (true positions, distances and colors), a
   procedural galaxy backdrop (labeled an illustration), a search combobox,
   an info card for any body, porkchop transfer planning for planets (the
   Mission-to-Mars machinery, generalized to all seven targets), and honest
   relativistic trip math for stars with a cruise animation that shows the
   ship clock and the Earth clock running apart.

   Modes: 'intro' | 'explore' | 'porkchop' | 'cruise'. Esc walks back.
   World units: AU everywhere; star positions convert ly -> AU at load.
   Theme-aware, Pointer Events + touch-action:none, pauses on hidden tabs,
   honors prefers-reduced-motion (no intro, no drift, instant camera moves,
   Launch jumps to the arrival summary). Original code.

   The leading PURE section is DOM-free and exported for node tests.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     PURE: formatting + small math helpers, no DOM. module.exports in node.
     ====================================================================== */
  var PURE = {};
  (function (P) {

    function fmtInt(n) {
      n = Math.round(n);
      var neg = n < 0;
      var s = String(Math.abs(n)), out = '';
      while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
      return (neg ? '-' : '') + s + out;
    }

    function round3sig(v) {
      if (!isFinite(v) || v === 0) return 0;
      var p = Math.pow(10, Math.floor(Math.log(Math.abs(v)) / Math.LN10) - 2);
      return Math.round(v / p) * p;
    }

    function fmtYears(y) {
      if (!isFinite(y) || y < 0) return '?';
      if (y < 1) {
        var mo = Math.max(1, Math.round(y * 12));
        return mo + (mo === 1 ? ' month' : ' months');
      }
      if (y < 10) return (Math.round(y * 10) / 10) + ' years';
      if (y < 100) return 'about ' + Math.round(y) + ' years';
      return fmtInt(round3sig(y)) + ' years';
    }

    var SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
                '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
                '-': '⁻' };
    function supInt(n) {
      var s = String(Math.round(n)), out = '', i;
      for (i = 0; i < s.length; i++) out += SUP[s.charAt(i)] || '';
      return out;
    }

    function fmtJoules(j) {
      if (!isFinite(j) || j <= 0) return '?';
      var e = Math.floor(Math.log(j) / Math.LN10);
      var m = Math.round(j / Math.pow(10, e) * 10) / 10;
      if (m >= 10) { m = 1; e += 1; }
      return m + '×10' + supInt(e) + ' J';
    }

    function energyPhrase(worldYears) {
      var tail = " of the world's entire energy production";
      if (!isFinite(worldYears)) return '?';
      if (worldYears >= 100) return 'about ' + fmtInt(round3sig(worldYears)) + ' years' + tail;
      if (worldYears >= 2) return 'about ' + Math.round(worldYears) + ' years' + tail;
      if (worldYears >= 1) return 'about ' + (Math.round(worldYears * 10) / 10) + ' years' + tail;
      var pct = worldYears * 100;
      if (pct >= 1) return 'about ' + Math.round(pct) + '% of one year' + tail;
      if (pct >= 0.01) return 'about ' + (Math.round(pct * 100) / 100) + '% of one year' + tail;
      return 'well under 0.01% of one year' + tail;
    }

    function fuelAmount(massRatio) {
      var f = massRatio - 1;
      if (!isFinite(f) || f <= 0) return null;
      if (f < 10) return String(Math.round(f * 10) / 10);
      if (f < 1000) return String(Math.round(f));
      if (f < 1e6) return fmtInt(round3sig(f));
      var e = Math.floor(Math.log(f) / Math.LN10);
      var m = Math.round(f / Math.pow(10, e));
      if (m >= 10) { m = 1; e += 1; }
      return m + '×10' + supInt(e);
    }

    function fmtSpeedC(v) {
      if (!isFinite(v) || v <= 0) return '0';
      if (v < 0.99) return v.toFixed(2);
      if (v < 0.9999) return v.toFixed(4);
      return v.toFixed(6);
    }

    function fmtGamma(g) {
      if (!isFinite(g)) return '?';
      if (g < 10) return String(Math.round(g * 10) / 10);
      if (g < 100) return String(Math.round(g));
      return fmtInt(round3sig(g));
    }

    /* apparent-magnitude words: the 4-5.5 band deliberately does not
       overstate faintness (a mag-4 star is an easy naked-eye object). */
    function magWords(mag) {
      if (!isFinite(mag)) return '';
      if (mag < 4) return 'is easily visible to the naked eye';
      if (mag <= 5.5) return 'is visible to the naked eye from a dark sky';
      return 'needs binoculars or a telescope';
    }

    function sizeVsSun(r) {
      if (!(r > 0) || !isFinite(r)) return null;
      var x = r >= 10 ? Math.round(r) : (r >= 1 ? Math.round(r * 10) / 10 : Math.round(r * 100) / 100);
      if (x > 0.93 && x < 1.08) return "about the Sun's width, roughly";
      return 'about ' + x + "× the Sun's width, roughly";
    }

    function distPhrase(ly) {
      if (!isFinite(ly)) return '?';
      if (ly < 10) return (Math.round(ly * 100) / 100) + ' light-years';
      if (ly < 100) return (Math.round(ly * 10) / 10) + ' light-years';
      return fmtInt(round3sig(ly)) + ' light-years';
    }

    function lightPhrase(ly, nowYear) {
      if (!isFinite(ly) || ly <= 0) return '';
      if (ly < 120) return 'the light you see left it in ' + Math.round(nowYear - ly);
      return 'the light you see left it about ' + fmtInt(round3sig(ly)) + ' years ago';
    }

    /* star sprite atlas coordinates: 3 size bands by apparent magnitude,
       16 color buckets by B-V index. */
    function bandOf(mag) {
      var m = (typeof mag === 'number' && isFinite(mag)) ? mag : 6;
      return m < 1.5 ? 0 : (m < 4 ? 1 : 2);
    }
    function bucketOf(ci) {
      var c = (typeof ci === 'number' && isFinite(ci)) ? ci : 0.65;
      var b = Math.floor((c + 0.4) / 2.4 * 16);
      return b < 0 ? 0 : (b > 15 ? 15 : b);
    }
    /* D4 -- the ONE blend the close-up keys off. A star orb whose drawn
       radius has fallen to ORB_MIN_PX is gone; at ORB_FADE_PX it owns the
       pixel entirely. Everything that used to switch on a distance (the
       orb, the exoplanet orbs, the atlas sprite that replaces the orb)
       reads this instead, so there is no distance at which the star being
       looked at has no representation on screen. */
    var ORB_MIN_PX = 2, ORB_FADE_PX = 6;
    var ORB_HOLD_AU = 30, K_SHRINK = 0.40;
    function orbBlend(rPx) {
      var r = (typeof rPx === 'number' && isFinite(rPx)) ? rPx : 0;
      var v = (r - ORB_MIN_PX) / (ORB_FADE_PX - ORB_MIN_PX);
      return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /* Scale bar: pick a nice 1/2/5 length that fits maxPx at the current
       zoom. Unit: AU below 0.1 ly, then ly, then kly. */
    function niceScale(auPerPx, maxPx, lyAU) {
      if (!(auPerPx > 0) || !(maxPx >= 40)) return null;
      var worldAU = maxPx * auPerPx;
      var unit, scaleAU;
      if (worldAU < 0.1 * lyAU) { unit = 'AU'; scaleAU = 1; }
      else if (worldAU < 1000 * lyAU) { unit = 'ly'; scaleAU = lyAU; }
      else { unit = 'kly'; scaleAU = lyAU * 1000; }
      var val = worldAU / scaleAU;
      var pow = Math.pow(10, Math.floor(Math.log(val) / Math.LN10));
      var nice = pow;
      if (5 * pow <= val) nice = 5 * pow;
      else if (2 * pow <= val) nice = 2 * pow;
      nice = Math.round(nice * 1e6) / 1e6;
      var lbl = (nice >= 1000 ? fmtInt(nice) : String(nice)) + ' ' + unit;
      return { px: nice * scaleAU / auPerPx, label: lbl, worldAU: nice * scaleAU };
    }

    /* Constant-acceleration flip trip, parameterized by SHIP proper time.
       Units: d in light-years, a in ly/yr^2, tau in years, c = 1.
       x(tau) = (cosh(a tau) - 1)/a, t(tau) = sinh(a tau)/a, decel mirrored. */
    function cruiseTotals(dLy, a) {
      if (!(dLy > 0) || !(a > 0)) return { tauHalf: 0, tauTotal: 0, tTotal: 0 };
      var chi = a * dLy / 2;
      var tauHalf = Math.acosh(1 + chi) / a;
      return { tauHalf: tauHalf, tauTotal: 2 * tauHalf,
               tTotal: 2 * Math.sqrt(chi * chi + 2 * chi) / a };
    }
    function cruisePoint(dLy, a, tau) {
      var tot = cruiseTotals(dLy, a);
      if (!(dLy > 0) || !(a > 0)) return { x: 0, t: 0, v: 0, g: 1, done: true };
      if (tau <= 0) return { x: 0, t: 0, v: 0, g: 1, done: false };
      if (tau >= tot.tauTotal) return { x: dLy, t: tot.tTotal, v: 0, g: 1, done: true };
      var h, x, t;
      if (tau <= tot.tauHalf) {
        h = a * tau;
        x = (Math.cosh(h) - 1) / a;
        t = Math.sinh(h) / a;
      } else {
        h = a * (tot.tauTotal - tau);
        x = dLy - (Math.cosh(h) - 1) / a;
        t = tot.tTotal - Math.sinh(h) / a;
      }
      return { x: x, t: t, v: Math.tanh(h), g: Math.cosh(h), done: false };
    }

    /* Share payload validation. The decoded hash is UNTRUSTED: everything
       here returns a safe shape or null (name resolution happens later and
       unknown names silently ignore the hash). */
    function normShare(o) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      var t = o.t;
      if (!Array.isArray(t) || t.length !== 2) return null;
      var kind = t[0], name = t[1];
      if (kind !== 'p' && kind !== 's' && kind !== 'x') return null;
      if (typeof name !== 'string' || name.length === 0 || name.length > 100) return null;
      function cint(v, lo, hi, d) {
        if (typeof v !== 'number' || !isFinite(v)) return d;
        v = Math.round(v);
        return (v < lo || v > hi) ? d : v;
      }
      return {
        kind: kind, name: name,
        a: cint(o.a, 0, 2, 1), m: cint(o.m, 0, 2, 1),
        d: (typeof o.d === 'number' && isFinite(o.d)) ? o.d : null,
        f: (typeof o.f === 'number' && isFinite(o.f)) ? o.f : null
      };
    }

    /* Search index: planets first, then stars by brightness (plus HIP
       aliases), then exoplanets. Matching is prefix-first then substring. */
    function buildSearchEntries(data, planetNames) {
      var entries = [], i;
      for (i = 0; i < planetNames.length; i++) {
        entries.push({ label: planetNames[i], kind: 'p', idx: i,
                       lower: planetNames[i].toLowerCase() });
      }
      if (data && data.stars) {
        var st = data.stars, n = st.name.length;
        var order = [];
        for (i = 0; i < n; i++) order.push(i);
        order.sort(function (a, b) {
          var ma = (typeof st.mag[a] === 'number') ? st.mag[a] : 99;
          var mb = (typeof st.mag[b] === 'number') ? st.mag[b] : 99;
          return ma - mb;
        });
        for (var k = 0; k < n; k++) {
          i = order[k];
          var nm = st.name[i];
          entries.push({ label: nm, kind: 's', idx: i, lower: nm.toLowerCase() });
          if (st.hip[i]) {
            var alias = 'HIP ' + st.hip[i];
            if (alias !== nm) {
              entries.push({ label: alias, kind: 's', idx: i, lower: alias.toLowerCase() });
            }
          }
        }
        if (data.planets) {
          var pl = data.planets;
          for (i = 0; i < pl.name.length; i++) {
            entries.push({ label: pl.name[i], kind: 'x', idx: i,
                           lower: pl.name[i].toLowerCase() });
          }
        }
      }
      return entries;
    }

    function searchQuery(entries, q, max) {
      q = (q || '').trim().toLowerCase();
      var out = [];
      if (!q) return out;
      var i, e;
      for (i = 0; i < entries.length && out.length < max; i++) {
        e = entries[i];
        if (e.lower.lastIndexOf(q, 0) === 0) out.push(e);
      }
      if (out.length < max) {
        for (i = 0; i < entries.length && out.length < max; i++) {
          e = entries[i];
          if (e.lower.indexOf(q) > 0 && out.indexOf(e) < 0) out.push(e);
        }
      }
      return out;
    }

    function fmt2x(v) {
      if (!isFinite(v)) return '?';
      if (v >= 10) return String(Math.round(v));
      if (v >= 1) return String(Math.round(v * 10) / 10);
      return String(Math.round(v * 100) / 100);
    }

    function perPhrase(days) {
      if (!isFinite(days) || days <= 0) return null;
      if (days < 10) return (Math.round(days * 10) / 10) + ' days';
      if (days < 1200) return Math.round(days) + ' days';
      var y = days / 365.25;
      return (y < 10 ? Math.round(y * 10) / 10 : Math.round(y)) + ' years';
    }

    /* One-line exoplanet chip text, e.g.
       "1.1x Earth's size, 11-day year, habitable zone (roughly)". */
    function chipLine(p, inHz) {
      var parts = [];
      if (p.rade != null && isFinite(p.rade)) parts.push(fmt2x(p.rade) + "× Earth's size");
      if (p.per != null && isFinite(p.per) && p.per > 0) {
        if (p.per < 1200) {
          parts.push((p.per < 10 ? Math.round(p.per * 10) / 10 : Math.round(p.per)) + '-day year');
        } else {
          parts.push((Math.round(p.per / 365.25 * 10) / 10) + '-year orbit');
        }
      } else if (p.a != null && isFinite(p.a)) {
        parts.push(fmt2x(p.a) + ' AU out');
      }
      if (inHz) parts.push('habitable zone (roughly)');
      return parts.length ? parts.join(', ') : 'little is known about it';
    }

    function methodWords(m) {
      if (typeof m !== 'string' || !m) return '';
      return m.toLowerCase();
    }

    /* Expanded chip detail lines. Wording is load-bearing: "about" on
       masses, "assuming no atmosphere" on eq temps, "roughly" on the HZ. */
    function chipDetail(p, inHz) {
      var lines = [];
      var per = perPhrase(p.per);
      if (per) lines.push('A year there lasts ' + per + '.');
      if (p.a != null && isFinite(p.a)) lines.push('It orbits ' + fmt2x(p.a) + ' AU from its star.');
      if (p.rade != null && isFinite(p.rade)) lines.push('About ' + fmt2x(p.rade) + "× Earth's width.");
      if (p.masse != null && isFinite(p.masse)) {
        lines.push('About ' + fmt2x(p.masse) + "× Earth's mass (often a minimum estimate).");
      }
      if (p.eqt != null && isFinite(p.eqt)) {
        lines.push('Roughly ' + Math.round(p.eqt) + ' K, assuming no atmosphere.');
      }
      if (inHz) lines.push('It sits in the habitable zone, roughly.');
      if (p.year != null && isFinite(p.year)) {
        var m = methodWords(p.method);
        lines.push('Found in ' + Math.round(p.year) + (m ? ' by ' + m : '') + '.');
      }
      if (!lines.length) lines.push('Little is known about this one beyond its existence.');
      return lines;
    }

    /* Porkchop TOF axis tick spacing: smallest of 1/2/5*10^k giving <= ~5.5
       ticks over the span. */
    function tofTickFor(spanDays) {
      var p = Math.pow(10, Math.floor(Math.log(spanDays / 5.5) / Math.LN10));
      var cands = [p, 2 * p, 5 * p, 10 * p], i;
      for (i = 0; i < cands.length; i++) {
        if (spanDays / cands[i] <= 5.5) return cands[i];
      }
      return 10 * p;
    }

    /* ==================================================================
       WAVE 3 additions. All still DOM-free and node-testable.
       ================================================================== */

    /* ---- galactic frame, J2000, pinned ----
       Galactic north pole  RA 192.85948 deg, Dec  27.12825 deg
       Galactic centre      RA 266.40500 deg, Dec -28.93617 deg
       The two published directions are not exactly perpendicular (they miss
       a right angle by 0.0066 arcsec), so the pole is orthogonalised against
       the centre rather than the other way round. That keeps the galactic
       centre EXACT, and the whole galaxy cloud is positioned from it. */
    var GAL_NGP_RA = 192.85948, GAL_NGP_DEC = 27.12825;
    var GAL_GC_RA = 266.40500, GAL_GC_DEC = -28.93617;
    var DEG_R = Math.PI / 180;

    function raDecUnit(raDeg, decDeg) {
      var ra = raDeg * DEG_R, dc = decDeg * DEG_R;
      var cd = Math.cos(dc);
      return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dc)];
    }
    var GAL_BASIS = null;
    function galBasis() {
      if (GAL_BASIS) return GAL_BASIS;
      var gx = raDecUnit(GAL_GC_RA, GAL_GC_DEC);          /* l = 0, b = 0 */
      var gz = raDecUnit(GAL_NGP_RA, GAL_NGP_DEC);        /* b = +90 */
      var d = gx[0] * gz[0] + gx[1] * gz[1] + gx[2] * gz[2];
      gz = [gz[0] - d * gx[0], gz[1] - d * gx[1], gz[2] - d * gx[2]];
      var n = Math.sqrt(gz[0] * gz[0] + gz[1] * gz[1] + gz[2] * gz[2]) || 1;
      gz = [gz[0] / n, gz[1] / n, gz[2] / n];
      var gy = [gz[1] * gx[2] - gz[2] * gx[1],            /* y = z cross x */
                gz[2] * gx[0] - gz[0] * gx[2],
                gz[0] * gx[1] - gz[1] * gx[0]];
      GAL_BASIS = { x: gx, y: gy, z: gz };
      return GAL_BASIS;
    }
    /* Cartesian galactic (x toward the centre, z toward the pole) ->
       equatorial J2000. Feed the result through VoyageAstro.equToEcl. */
    function galToEqu(gx, gy, gz, out) {
      var B = galBasis(), X = B.x, Y = B.y, Z = B.z;
      var o = out || [0, 0, 0];
      o[0] = gx * X[0] + gy * Y[0] + gz * Z[0];
      o[1] = gx * X[1] + gy * Y[1] + gz * Z[1];
      o[2] = gx * X[2] + gy * Y[2] + gz * Z[2];
      return o;
    }

    /* ---- cruise cinematic phase machine ----
       Seven beats, ~22 s end to end. The flight window (accel + flip + decel)
       maps linearly onto SHIP proper time, and the flip window is centred on
       that window so the turn happens exactly at the tau midpoint. */
    var CRUISE_PHASES = [
      { name: 'depart-zoom', ms: 2500 },
      { name: 'ignite',      ms: 1500 },
      { name: 'accel',       ms: 7000 },
      { name: 'flip',        ms: 2000 },
      { name: 'decel',       ms: 7000 },
      { name: 'capture',     ms: 2500 }
    ];
    var CRUISE_FLIGHT_T0 = 4000;      /* depart-zoom + ignite */
    var CRUISE_FLIGHT_MS = 16000;     /* accel + flip + decel */
    var CRUISE_TOTAL_MS = 22500;      /* the plan's "about 22 seconds" */

    function smooth01(x) {
      if (!(x > 0)) return 0;
      if (x >= 1) return 1;
      return x * x * (3 - 2 * x);
    }
    function cruisePhaseAt(ms, tauTotal) {
      var tt = (typeof tauTotal === 'number' && isFinite(tauTotal) && tauTotal > 0) ? tauTotal : 0;
      var m = (typeof ms === 'number' && isFinite(ms)) ? ms : 0;
      if (m < 0) m = 0;
      if (m >= CRUISE_TOTAL_MS) {
        return { phase: 'arrived', k: 1, tau: tt, thrust: 0, flip: 1, swing: 1, done: true };
      }
      var i, acc = 0, name = 'depart-zoom', k = 0;
      for (i = 0; i < CRUISE_PHASES.length; i++) {
        if (m < acc + CRUISE_PHASES[i].ms) {
          name = CRUISE_PHASES[i].name;
          k = (m - acc) / CRUISE_PHASES[i].ms;
          break;
        }
        acc += CRUISE_PHASES[i].ms;
      }
      var tau = 0;
      if (m > CRUISE_FLIGHT_T0) {
        var f = (m - CRUISE_FLIGHT_T0) / CRUISE_FLIGHT_MS;
        tau = tt * (f < 0 ? 0 : (f > 1 ? 1 : f));
      }
      var thrust = 0, flip = 0, swing = 0;
      if (name === 'ignite') thrust = smooth01(k);
      else if (name === 'accel') thrust = 1;
      else if (name === 'flip') {
        /* engines off through the turn, easing out and back in at the edges */
        thrust = k < 0.15 ? (1 - k / 0.15) : (k > 0.85 ? (k - 0.85) / 0.15 : 0);
        flip = smooth01((k - 0.12) / 0.76);
        /* the cockpit sky swings 180 deg over 0.6 s inside the 2 s turn */
        swing = smooth01((k * 2000 - 700) / 600);
      } else if (name === 'decel') { thrust = 1; flip = 1; swing = 1; }
      else if (name === 'capture') { thrust = 1 - k; flip = 1; swing = 1; }
      return { phase: name, k: k, tau: tau, thrust: thrust,
               flip: flip, swing: swing, done: false };
    }

    /* ==================================================================
       D2: the continuous cruise pose.

       PURE.cruisePose is layered OVER cruisePhaseAt, which stays the sole
       authority for the timeline, the labels, tau, thrust, flip and swing.
       This adds what a camera rig needs and the phase machine never had: a
       ship ORIENTATION (a quaternion, so the flip can roll the whole sky
       instead of sweeping a yaw angle), a world position that starts on a
       real parking orbit and ends short of the star in a capture orbit,
       and a shake envelope. Nothing here reads the DOM or the clock.
       ================================================================== */

    /* quaternions, (x, y, z, w), right-handed, columns (X, Y, Z).
       ONE convention trap, and it is the reason this comment exists: the
       page's camera triple is LEFT handed (updateCamBasis sets u =
       cross(r, f), so r x u = -f). A quaternion cannot express that, so the
       rig carries the right-handed triple (X = cross(U, F), Y = U, Z = F)
       and negates X on the way out to get the page's r. */
    function qAxisAngle(ax, ay, az, ang, out) {
      var h = ang * 0.5, s = Math.sin(h);
      var o = out || [0, 0, 0, 1];
      o[0] = ax * s; o[1] = ay * s; o[2] = az * s; o[3] = Math.cos(h);
      return o;
    }
    function qMul(a, b, out) {
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var bx = b[0], by = b[1], bz = b[2], bw = b[3];
      var o = out || [0, 0, 0, 1];
      o[0] = aw * bx + ax * bw + ay * bz - az * by;
      o[1] = aw * by - ax * bz + ay * bw + az * bx;
      o[2] = aw * bz + ax * by - ay * bx + az * bw;
      o[3] = aw * bw - ax * bx - ay * by - az * bz;
      return o;
    }
    function qNormalize(q) {
      var n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
      if (!(n > 1e-12)) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; return q; }
      q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
      return q;
    }
    function qRot(q, vx, vy, vz, out) {
      var x = q[0], y = q[1], z = q[2], w = q[3];
      /* t = 2 * (q_vec x v); v' = v + w t + q_vec x t */
      var tx = 2 * (y * vz - z * vy);
      var ty = 2 * (z * vx - x * vz);
      var tz = 2 * (x * vy - y * vx);
      var o = out || [0, 0, 0];
      o[0] = vx + w * tx + (y * tz - z * ty);
      o[1] = vy + w * ty + (z * tx - x * tz);
      o[2] = vz + w * tz + (x * ty - y * tx);
      return o;
    }
    function qSlerp(a, b, t, out) {
      var o = out || [0, 0, 0, 1];
      var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      var bx = b[0], by = b[1], bz = b[2], bw = b[3];
      if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      var k0, k1;
      if (d > 0.9995) { k0 = 1 - t; k1 = t; }
      else {
        var th = Math.acos(d > 1 ? 1 : d), s = Math.sin(th);
        k0 = Math.sin((1 - t) * th) / s;
        k1 = Math.sin(t * th) / s;
      }
      o[0] = a[0] * k0 + bx * k1; o[1] = a[1] * k0 + by * k1;
      o[2] = a[2] * k0 + bz * k1; o[3] = a[3] * k0 + bw * k1;
      return qNormalize(o);
    }
    /* geodesic angle between two orientations, radians */
    function qAngle(a, b) {
      var d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      if (d > 1) d = 1;
      return 2 * Math.acos(d);
    }
    /* orthonormal columns (R, U, F) -> quaternion */
    function qFromBasis(rx, ry, rz, ux, uy, uz, fx, fy, fz, out) {
      var o = out || [0, 0, 0, 1];
      var tr = rx + uy + fz, s;
      if (tr > 0) {
        s = Math.sqrt(tr + 1) * 2;
        o[3] = 0.25 * s; o[0] = (uz - fy) / s; o[1] = (fx - rz) / s; o[2] = (ry - ux) / s;
      } else if (rx > uy && rx > fz) {
        s = Math.sqrt(1 + rx - uy - fz) * 2;
        o[3] = (uz - fy) / s; o[0] = 0.25 * s; o[1] = (ux + ry) / s; o[2] = (fx + rz) / s;
      } else if (uy > fz) {
        s = Math.sqrt(1 + uy - rx - fz) * 2;
        o[3] = (fx - rz) / s; o[0] = (ux + ry) / s; o[1] = 0.25 * s; o[2] = (fy + uz) / s;
      } else {
        s = Math.sqrt(1 + fz - rx - uy) * 2;
        o[3] = (ry - ux) / s; o[0] = (fx + rz) / s; o[1] = (fy + uz) / s; o[2] = 0.25 * s;
      }
      return qNormalize(o);
    }

    /* ---- rig geometry, pinned (CL-09) ---- */
    var SHIP_LEN_AU = 1.337e-9;      /* a 200 m hull, stated honestly; units only */
    var RIG_BACK = 2.2, RIG_UP = 0.35, RIG_SIDE = 0.55;   /* ship-lengths */
    var RIG_LEN = 2.295;             /* |RIG_OFFSET| */
    var SHIP_PX_K = 0.55;
    var RIG_D_MIN = 0.6, RIG_D_MAX = 8;
    /* the parking orbit the ship leaves from and the capture orbit it stops
       in. 10^0.62 and 10^0.75 AU, the two zoom levels the shipped cinematic
       already framed those beats at, so the handoffs land exactly. */
    var DEPART_AU = 4.1687, ARRIVE_AU = 5.6234;
    var DEP_OMEGA = 0.42;            /* parking-orbit angular rate, rad/s */
    var DEP_TH0 = 0.7;
    var DEP_SPAN_AU = 4000;          /* travel over which the arc straightens */
    var DEP_LEAD = 0.50;             /* nose lead onto the orbital tangent, rad */
    var DEP_SIDE = 0.40, DEP_BACK = 1.00;   /* parking offset, in DEPART_AU */
    var BANK_DEP = 0.42, BANK_ARR = -0.5, FLIP_ROLL = 1.15;

    function num1(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    /* Two unit vectors perpendicular to u, chosen deterministically. */
    function perpBasis(ux, uy, uz, out) {
      var wx = 0, wy = 0, wz = 1;
      if (Math.abs(uz) > 0.999) { wx = 0; wy = 1; wz = 0; }
      var ax = uy * wz - uz * wy, ay = uz * wx - ux * wz, az = ux * wy - uy * wx;
      var n = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!(n > 1e-12)) { ax = 1; ay = 0; az = 0; n = 1; }
      ax /= n; ay /= n; az /= n;
      var bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
      var o = out || {};
      o.ax = ax; o.ay = ay; o.az = az;
      o.bx = bx; o.by = by; o.bz = bz;
      return o;
    }

    var PP_TMP = {};
    function cruisePose(tSec, plan) {
      var t = num1(tSec, 0);
      if (t < 0) t = 0;
      var p = plan || {};
      var tauTotal = num1(p.tauTotal, 0);
      var ph = cruisePhaseAt(t * 1000, tauTotal);
      var dLy = num1(p.dLy, 0), acc = num1(p.a, 0);
      var cp = cruisePoint(dLy, acc, ph.tau);
      var dist = num1(p.distAU, 0);
      if (!(dist > 0)) dist = 1;
      var s01 = dLy > 0 ? clamp01(cp.x / dLy) : (ph.done ? 1 : 0);

      var ux = num1(p.ux, 1), uy = num1(p.uy, 0), uz = num1(p.uz, 0);
      var un = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (!(un > 1e-12)) { ux = 1; uy = 0; uz = 0; un = 1; }
      ux /= un; uy /= un; uz /= un;

      /* along-route distance: starts at 0 (still parked) and stops one
         capture-orbit radius short of the star, so the last frame of the
         cinematic is already the pose explore mode inherits. */
      var travel = Math.min(dist * s01, Math.max(0, dist - ARRIVE_AU));
      /* the straightening span scales down for an implausibly short hop so
         the parking arc can never outlive the trip */
      var depSpan = Math.max(50, Math.min(DEP_SPAN_AU, dist * 0.02));
      var depW = 1 - smooth01(travel / depSpan);

      /* The parking orbit sits BEHIND the body along the route and a little
         to one side, not straight out to the side: a body 90 degrees off the
         heading cannot share a 55 degree frame with the ship, and no camera
         aim fixes that without throwing the ship out instead. Offset this
         way the body is about 22 degrees off the nose, so the departure
         really does open on the world being left, and the ship then swings
         past it at about 1.7 AU as the engines light. */
      var pb = perpBasis(ux, uy, uz, PP_TMP);
      var th = DEP_TH0 + DEP_OMEGA * t;
      var ct = Math.cos(th), st = Math.sin(th);
      var offR = DEPART_AU * DEP_SIDE * depW;
      var offB = DEPART_AU * DEP_BACK * depW;
      var along = travel - offB;
      var px0 = num1(p.ox, 0) + ux * along + offR * (ct * pb.ax + st * pb.bx);
      var py0 = num1(p.oy, 0) + uy * along + offR * (ct * pb.ay + st * pb.by);
      var pz0 = num1(p.oz, 0) + uz * along + offR * (ct * pb.az + st * pb.bz);

      /* Base frame from the ROUTE direction, which is constant for a whole
         cruise. Deriving the up vector from the (moving) nose instead would
         put a hard branch inside the frame: a route within 30 degrees of the
         ecliptic pole made the reference axis flip mid-flight and the sky
         snapped through 2.5 rad in one frame. */
      var wx = 0, wy = 0, wz = 1;
      if (Math.abs(uz) > 0.9) { wx = 0; wy = 1; wz = 0; }
      var dp = wx * ux + wy * uy + wz * uz;
      var sux = wx - dp * ux, suy = wy - dp * uy, suz = wz - dp * uz;
      var sn = Math.sqrt(sux * sux + suy * suy + suz * suz);
      if (!(sn > 1e-12)) { sux = 0; suy = 1; suz = 0; sn = 1; }
      sux /= sn; suy /= sn; suz /= sn;
      /* X = cross(U, F): the right-handed partner of the page's r = -X */
      var srx = suy * uz - suz * uy, sry = suz * ux - sux * uz, srz = sux * uy - suy * ux;

      var q0 = qFromBasis(srx, sry, srz, sux, suy, suz, ux, uy, uz);

      /* The nose leads onto the orbital tangent while the ship is still
         parked, as a yaw about its OWN up axis, so the horizon stays put.
         The lead stays under 30 degrees: past about 50 the forward half of
         the aberrated sky would start showing stars from behind. */
      var leadAng = DEP_LEAD * depW * ct;
      /* the flip is a real 180 degree rotation about the ship's own up axis,
         and the capture turn takes the nose back to the star. */
      var capK = ph.phase === 'capture' ? smooth01((ph.k - 0.05) / 0.75) : (ph.done ? 1 : 0);
      var flipAng = leadAng + Math.PI * (ph.flip - capK);
      /* roll: a transient through the flip (this is what visibly spins the
         sky), plus a bank INTO the parking turn and one into the capture */
      var bankArr = ph.phase === 'capture'
        ? BANK_ARR * Math.sin(Math.PI * clamp01(ph.k / 0.9)) : 0;
      var roll = FLIP_ROLL * Math.sin(Math.PI * ph.flip) - BANK_DEP * depW * st + bankArr;

      var q = qMul(q0, qAxisAngle(0, 1, 0, flipAng));
      q = qMul(q, qAxisAngle(0, 0, 1, roll));
      qNormalize(q);

      var X = qRot(q, 1, 0, 0), U = qRot(q, 0, 1, 0), F = qRot(q, 0, 0, 1);
      return {
        s01: s01,
        beta: cp.v,
        thrust01: ph.thrust,
        flip01: ph.flip,
        shipQ: q,
        phaseLabel: ph.phase,
        shake01: ph.thrust,
        /* extras the rig needs; the timeline itself is unchanged */
        tau: ph.tau, tEarth: cp.t, gamma: cp.g, done: ph.done, k: ph.k,
        travel: travel, depW: depW, roll: roll, capTurn: capK,
        x: px0, y: py0, z: pz0,
        basis: { fX: F[0], fY: F[1], fZ: F[2],
                 rX: -X[0], rY: -X[1], rZ: -X[2],
                 uX: U[0], uY: U[1], uZ: U[2] },
        rigLen: RIG_LEN
      };
    }

    /* ---- D3: the cockpit caption track ----
       t is milliseconds from cruise start, the same clock cruisePhaseAt
       uses. The flip caption is not in this list: it fires off the phase in
       BOTH views and outranks everything here. */
    function cockpitCaptions() {
      return [
        { t: 700, ms: 3000,
          text: 'Your ship is still in orbit. The engines are cold.',
          alt: ['Your ship is still in orbit. The engines are cold.',
                'Still in orbit. Engines cold.'] },
        { t: 2600, ms: 3200,
          text: 'Engines lit. From here it is one steady burn, straight out.',
          alt: ['Engines lit. From here it is one steady burn, straight out.',
                'Engines lit. One steady burn, straight out.',
                'Engines lit.'] },
        { t: 5200, ms: 3400,
          text: 'The stars ahead are starting to crowd together as the speed climbs.',
          alt: ['The stars ahead are starting to crowd together as the speed climbs.',
                'The stars ahead are crowding together.',
                'The stars are crowding ahead.'] },
        { t: 8200, ms: 4800,
          text: 'The sky bunches up ahead and turns blue. That is what relativity says you would see.',
          two: ['The sky bunches up ahead and turns blue.',
                'That is what relativity says you would see.'],
          alt: ['The sky bunches up ahead and turns blue. That is what relativity says you would see.'] },
        { t: 13600, ms: 3400,
          text: 'Braking now. The engines face the way you came and fight your own speed.',
          alt: ['Braking now. The engines face the way you came and fight your own speed.',
                'Braking. The engines fight your own speed.',
                'Braking.'] },
        { t: 20200, ms: 2400,
          text: 'Slowing into orbit. The two clocks stop drifting apart now.',
          alt: ['Slowing into orbit. The two clocks stop drifting apart now.',
                'Slowing into orbit.'] }
      ];
    }

    /* ---- relativistic aberration + Doppler ----
       cosTheta is measured in the REST frame of the stars, from the ship's
       direction of travel. Both formulas are the textbook ones, pinned. */
    function betaClamp(b) {
      if (typeof b !== 'number' || !isFinite(b)) return 0;
      if (b <= 0) return 0;
      return b > 0.9999999 ? 0.9999999 : b;
    }
    function aberrateCos(c, beta) {
      var b = betaClamp(beta);
      if (typeof c !== 'number' || !isFinite(c)) return 0;
      if (c > 1) c = 1; else if (c < -1) c = -1;
      if (b === 0) return c;
      var den = 1 + b * c;
      if (!(den > 1e-12)) return -1;
      var v = (c + b) / den;
      return v > 1 ? 1 : (v < -1 ? -1 : v);
    }
    function dopplerFactor(c, beta) {
      var b = betaClamp(beta);
      if (typeof c !== 'number' || !isFinite(c)) return 1;
      if (c > 1) c = 1; else if (c < -1) c = -1;
      if (b === 0) return 1;
      var g = 1 / Math.sqrt(1 - b * b);
      var den = g * (1 - b * c);
      if (!(den > 1e-9)) return 1;
      return 1 / den;
    }
    /* The aberrated world direction of a source seen from a ship moving
       along the unit vector (ux,uy,uz) at beta. It takes the VELOCITY and
       nothing else: where the crew happen to be looking cannot move where
       the sky bunches up, so no view basis is an argument here (CL-23). */
    var AB_OUT = { x: 0, y: 0, z: 0, cos: 0, delta: 1 };
    function aberrateDir(ux, uy, uz, dx, dy, dz, beta, out) {
      var o = out || AB_OUT;
      var n = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(n > 1e-12)) { o.x = ux; o.y = uy; o.z = uz; o.cos = 1; o.delta = 1; return o; }
      dx /= n; dy /= n; dz /= n;
      var cth = dx * ux + dy * uy + dz * uz;
      if (cth > 1) cth = 1; else if (cth < -1) cth = -1;
      var cth2 = aberrateCos(cth, beta);
      var s1 = Math.sqrt(Math.max(0, 1 - cth * cth));
      var s2 = Math.sqrt(Math.max(0, 1 - cth2 * cth2));
      if (s1 > 1e-9) {
        var px = (dx - cth * ux) / s1, py = (dy - cth * uy) / s1, pz = (dz - cth * uz) / s1;
        o.x = cth2 * ux + s2 * px; o.y = cth2 * uy + s2 * py; o.z = cth2 * uz + s2 * pz;
      } else {
        var sg = cth2 >= 0 ? 1 : -1;
        o.x = sg * ux; o.y = sg * uy; o.z = sg * uz;
      }
      o.cos = cth;
      o.delta = dopplerFactor(cth, beta);
      return o;
    }

    /* ---- background star tier decode ----
       voyage-bg.js ships { n, scale, b64 }; b64 is n records of 8 bytes,
       little-endian: int16 x, y, z (ecliptic light-years x scale), uint8
       mag x 10, uint8 ci x 100 + 50 (255 = unknown). Records are sorted
       brightest first, which is what makes the LOD cuts a simple prefix. */
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64REV = null;
    function b64Bytes(s) {
      if (typeof s !== 'string') return null;
      if (!B64REV) {
        B64REV = {};
        for (var q = 0; q < 64; q++) B64REV[B64.charAt(q)] = q;
      }
      var clean = s.replace(/[^A-Za-z0-9+/]/g, '');
      var n = Math.floor(clean.length / 4) * 3;
      var pad = 0;
      if (s.charAt(s.length - 1) === '=') pad++;
      if (s.charAt(s.length - 2) === '=') pad++;
      var out = new Uint8Array(n - pad);
      var i = 0, o = 0, acc, c0, c1, c2, c3;
      for (i = 0; i + 3 < clean.length; i += 4) {
        c0 = B64REV[clean.charAt(i)]; c1 = B64REV[clean.charAt(i + 1)];
        c2 = B64REV[clean.charAt(i + 2)]; c3 = B64REV[clean.charAt(i + 3)];
        if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) return null;
        acc = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
        if (o < out.length) out[o++] = (acc >> 16) & 255;
        if (o < out.length) out[o++] = (acc >> 8) & 255;
        if (o < out.length) out[o++] = acc & 255;
      }
      return out;
    }
    /* auPerLy lets the page hand over VoyageAstro.LY_AU; default 1 keeps the
       output in light-years for tests. */
    function bgDecode(o, auPerLy) {
      if (!o || typeof o !== 'object') return null;
      var n = o.n;
      if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
      n = Math.floor(n);
      var scale = (typeof o.scale === 'number' && isFinite(o.scale) && o.scale > 0) ? o.scale : 8;
      var bytes = b64Bytes(o.b64);
      if (!bytes || bytes.length < n * 8) return null;
      var k = (typeof auPerLy === 'number' && isFinite(auPerLy) && auPerLy > 0) ? auPerLy : 1;
      var f = k / scale;
      var x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
      var mag = new Float32Array(n), ci = new Float32Array(n);
      var i, p, v;
      for (i = 0; i < n; i++) {
        p = i * 8;
        v = bytes[p] | (bytes[p + 1] << 8); if (v > 32767) v -= 65536;
        x[i] = v * f;
        v = bytes[p + 2] | (bytes[p + 3] << 8); if (v > 32767) v -= 65536;
        y[i] = v * f;
        v = bytes[p + 4] | (bytes[p + 5] << 8); if (v > 32767) v -= 65536;
        z[i] = v * f;
        mag[i] = bytes[p + 6] / 10;
        ci[i] = bytes[p + 7] === 255 ? NaN : (bytes[p + 7] - 50) / 100;
      }
      return { n: n, scale: scale, x: x, y: y, z: z, mag: mag, ci: ci };
    }
    /* 12 buckets: 4 colour groups x 3 brightness groups. */
    function bgBucket(ciV, magV) {
      var c = (typeof ciV === 'number' && isFinite(ciV)) ? ciV : 0.65;
      var cg = c < 0.2 ? 0 : (c < 0.6 ? 1 : (c < 1.1 ? 2 : 3));
      var m = (typeof magV === 'number' && isFinite(magV)) ? magV : 8;
      var mg = m < 6.6 ? 0 : (m < 7.4 ? 1 : 2);
      return cg * 3 + mg;
    }

    /* ---- persistent ship location ----
       sessionStorage is UNTRUSTED like any hash: clamp on read, and fall
       back to Earth. */
    function normShipAt(o, nPlanets, nStars) {
      var np = (typeof nPlanets === 'number' && nPlanets > 0) ? Math.floor(nPlanets) : 8;
      var ns = (typeof nStars === 'number' && nStars > 0) ? Math.floor(nStars) : 0;
      var fb = { kind: 'p', idx: 2 };
      if (!o || typeof o !== 'object' || Array.isArray(o)) return fb;
      var kind = o.kind, idx = o.idx;
      if (kind !== 'p' && kind !== 's') return fb;
      if (typeof idx !== 'number' || !isFinite(idx)) return fb;
      idx = Math.round(idx);
      var lim = kind === 'p' ? np : ns;
      if (idx < 0 || idx >= lim) return fb;
      return { kind: kind, idx: idx };
    }
    function sameShipAt(a, b) {
      return !!(a && b && a.kind === b.kind && a.idx === b.idx);
    }

    P.fmtInt = fmtInt;
    P.round3sig = round3sig;
    P.fmtYears = fmtYears;
    P.supInt = supInt;
    P.fmtJoules = fmtJoules;
    P.energyPhrase = energyPhrase;
    P.fuelAmount = fuelAmount;
    P.fmtSpeedC = fmtSpeedC;
    P.fmtGamma = fmtGamma;
    P.magWords = magWords;
    P.sizeVsSun = sizeVsSun;
    P.distPhrase = distPhrase;
    P.lightPhrase = lightPhrase;
    P.bandOf = bandOf;
    P.bucketOf = bucketOf;
    P.orbBlend = orbBlend;
    P.ORB_MIN_PX = ORB_MIN_PX;
    P.ORB_FADE_PX = ORB_FADE_PX;
    P.ORB_HOLD_AU = ORB_HOLD_AU;
    P.K_SHRINK = K_SHRINK;
    P.niceScale = niceScale;
    P.cruiseTotals = cruiseTotals;
    P.cruisePoint = cruisePoint;
    P.normShare = normShare;
    P.buildSearchEntries = buildSearchEntries;
    P.searchQuery = searchQuery;
    P.fmt2x = fmt2x;
    P.perPhrase = perPhrase;
    P.chipLine = chipLine;
    P.chipDetail = chipDetail;
    P.tofTickFor = tofTickFor;
    P.raDecUnit = raDecUnit;
    P.galBasis = galBasis;
    P.galToEqu = galToEqu;
    P.GAL_ANCHOR = { ngpRa: GAL_NGP_RA, ngpDec: GAL_NGP_DEC,
                     gcRa: GAL_GC_RA, gcDec: GAL_GC_DEC };
    P.CRUISE_PHASES = CRUISE_PHASES;
    P.CRUISE_TOTAL_MS = CRUISE_TOTAL_MS;
    P.CRUISE_FLIGHT_T0 = CRUISE_FLIGHT_T0;
    P.CRUISE_FLIGHT_MS = CRUISE_FLIGHT_MS;
    P.cruisePhaseAt = cruisePhaseAt;
    P.smooth01 = smooth01;
    P.cruisePose = cruisePose;
    P.cockpitCaptions = cockpitCaptions;
    P.qAxisAngle = qAxisAngle;
    P.qMul = qMul;
    P.qRot = qRot;
    P.qSlerp = qSlerp;
    P.qAngle = qAngle;
    P.qFromBasis = qFromBasis;
    P.qNormalize = qNormalize;
    P.SHIP_LEN_AU = SHIP_LEN_AU;
    P.RIG_OFFSET = { back: RIG_BACK, up: RIG_UP, side: RIG_SIDE };
    P.RIG_LEN = RIG_LEN;
    P.SHIP_PX_K = SHIP_PX_K;
    P.RIG_D_MIN = RIG_D_MIN;
    P.RIG_D_MAX = RIG_D_MAX;
    P.DEPART_AU = DEPART_AU;
    P.ARRIVE_AU = ARRIVE_AU;
    P.aberrateCos = aberrateCos;
    P.aberrateDir = aberrateDir;
    P.dopplerFactor = dopplerFactor;
    P.b64Bytes = b64Bytes;
    P.bgDecode = bgDecode;
    P.bgBucket = bgBucket;
    P.normShipAt = normShipAt;
    P.sameShipAt = sameShipAt;
  })(PURE);

  if (typeof module !== 'undefined' && module.exports) { module.exports = PURE; return; }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ======================================================================
     Page runtime (browser only).
     ====================================================================== */
  var canvas = document.getElementById('voy-canvas');
  if (!canvas || !window.VoyageAstro) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var A = window.VoyageAstro;
  var SD = window.VOYAGE_DATA || null;
  if (!SD) {
    /* belt and suspenders: a failed voyage-data.js fetch degrades to a
       solar-system-only page, never a blank screen */
    try { console.warn('voyage: VOYAGE_DATA missing; stars are unavailable.'); } catch (e0) {}
  }

  function id(x) { return document.getElementById(x); }
  var elPanel = id('voy-panel'), elCollapse = id('voy-collapse'), elHelp = id('voy-help');
  var elSearch = id('voy-search'), elList = id('voy-search-list');
  var elTarget = id('voy-target'), statusEl = id('voy-status'), verifyEl = id('voy-verify');
  var btnShare = id('voy-share'), btnSave = id('voy-save');
  var btnLaunch = id('voy-launch'), btnNext = id('voy-next'), btnBack = id('voy-back');
  var elPcRow = id('voy-pc-row');
  var elWinDetails = id('voy-window-details'), elWinSum = id('voy-window-sum'), elWinText = id('voy-window-text');
  var cardEl = id('voy-card');

  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FONT = '"Source Sans 3", system-ui, sans-serif';
  var DEG = Math.PI / 180;
  var LY_AU = A.LY_AU;
  var PLANET_KEYS = A.PLANETS;
  var PLANET_LABELS = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  var PLANET_R = [2.6, 3.6, 4, 3, 5, 4.6, 4, 4];

  var nowD = new Date();
  var jdToday = A.dateToJD(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, nowD.getUTCDate());
  var jd0 = jdToday - 30;
  var thisYearFrac = nowD.getUTCFullYear() +
    (jdToday - A.dateToJD(nowD.getUTCFullYear(), 1, 1)) / 365.25;
  var JD_2050 = A.dateToJD(2050, 12, 31);
  var JD_EXTRAP = A.dateToJD(2051, 1, 1);

  /* ---------------- state ---------------- */
  var mode = 'explore';                 /* 'intro' | 'explore' | 'porkchop' | 'cruise' */
  var introSt = null;                   /* {t0} */
  var tagStart = null, tagKill = null;  /* tagline timing */
  var attract = !reduced;               /* gentle drift until first input */
  var viewJD = jdToday;
  var sel = null;                       /* {kind:'p'|'s', idx} */
  var selExo = -1;                      /* global exoplanet index or -1 */
  var hover = null;                     /* {kind, idx} (mouse only) */
  var lastTap = null;                   /* {name, t} for manual double-tap */
  var centeredStar = -1;                /* star index the camera is parked on */
  var cruiseSt = null;                  /* star cruise state */
  var panelUi = null;                   /* GadgetUI.initPanel handle */
  var arriveInfo = null;                /* arrival summary for the card */
  var starPulse = 0;                    /* arrival ring pulse t0 */
  var accelIdx = 1, shipIdx = 1;        /* trip controls (1 g, crewed ship) */
  var fpMode = false;                   /* cruise view: false = chase, true = cockpit */
  var flipCapT0 = 0;                    /* flip caption timestamp */
  var previews = null;                  /* live card preview canvases */
  var panelOpen = true;
  var sbRect = null;                    /* last scale-bar rect (test hook) */
  var camBefore = null;                 /* camera snapshot to restore on porkchop exit */

  /* porkchop state (ported from mars.js) */
  var pcTarget = null;                  /* planet key while in/after porkchop */
  var specs = {}, jobs = {}, pcSel = {};
  var readoutCache = {};
  var ghost = null;
  var pcCache = null, pcDirty = true, lastPcPaint = 0;
  var pcCruise = null;                  /* {info, t0, ms, trail} */
  var arrivedPulse = 0;
  var dragKind = null;                  /* 'pc' | 'tl' */
  var L = null;
  var ariaLast = 0, ariaPend = null;

  /* ---------------- theme ---------------- */
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function isLight() { return effectiveTheme() === 'light'; }
  function bg() { return isLight() ? '#f3f5f8' : '#0e1014'; }
  function accent() { return isLight() ? '#34568a' : '#82a6cc'; }
  function gold() { return isLight() ? '#a07c2c' : '#c8a45c'; }
  function textColor(a) { return isLight() ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }
  function panelFill() { return isLight() ? 'rgba(255,255,255,0.94)' : 'rgba(18,20,24,0.92)'; }

  var RAMP_DARK = [[4.5, 233, 239, 246], [7, 130, 166, 204], [10.5, 60, 78, 99], [14, 20, 20, 20]];
  var RAMP_LIGHT = [[4.5, 22, 42, 74], [7, 52, 86, 138], [10.5, 150, 172, 199], [14, 255, 255, 255]];
  function dvColor(dv, light) {
    var R = light ? RAMP_LIGHT : RAMP_DARK;
    if (dv <= R[0][0]) return [R[0][1], R[0][2], R[0][3]];
    var last = R[R.length - 1];
    if (dv >= last[0]) return [last[1], last[2], last[3]];
    for (var k = 1; k < R.length; k++) {
      if (dv <= R[k][0]) {
        var f = (dv - R[k - 1][0]) / (R[k][0] - R[k - 1][0]);
        return [
          Math.round(R[k - 1][1] + f * (R[k][1] - R[k - 1][1])),
          Math.round(R[k - 1][2] + f * (R[k][2] - R[k - 1][2])),
          Math.round(R[k - 1][3] + f * (R[k][3] - R[k - 1][3]))
        ];
      }
    }
    return [last[1], last[2], last[3]];
  }

  /* ---------------- misc helpers ---------------- */
  function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ramp(v, lo, hi) { return v <= lo ? 0 : (v >= hi ? 1 : (v - lo) / (hi - lo)); }
  function easeInOutCubic(s) { return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2; }
  /* One definition of "the calendar year back on Earth", so the last HUD frame
     and the arrival card can never disagree by one. */
  function calYear(earthYearsPassed) {
    var y = thisYearFrac + (isFinite(earthYearsPassed) ? earthYearsPassed : 0);
    return isFinite(y) ? Math.floor(y) : nowD.getUTCFullYear();
  }
  function fmtDate(jd) {
    var d = A.jdToDate(jd);
    return d.d + ' ' + MON[d.m - 1] + ' ' + d.y;
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function liveStatusText(txt) {
    var t = performance.now();
    if (t - ariaLast > 400) { ariaLast = t; setStatus(txt); ariaPend = null; }
    else ariaPend = txt;
  }

  /* ---------------- star catalog -> typed arrays ---------------- */
  var NS = SD && SD.stars ? SD.stars.name.length : 0;
  var starX = new Float64Array(NS), starY = new Float64Array(NS), starZ = new Float64Array(NS);
  var starLyD = new Float64Array(NS);
  var starCellX = new Int16Array(NS), starCellY = new Int16Array(NS);
  var scrX = new Float32Array(NS), scrY = new Float32Array(NS);
  var scrOk = new Uint8Array(NS);
  var starsVis = false;
  var bandLists = [[], [], []];
  var starPlanets = {};                 /* star index -> [exo indices] */
  (function loadStars() {
    if (!SD || !SD.stars) return;
    var st = SD.stars, i;
    for (i = 0; i < NS; i++) {
      starX[i] = st.x[i] * LY_AU;
      starY[i] = st.y[i] * LY_AU;
      starZ[i] = st.z[i] * LY_AU;
      starLyD[i] = Math.sqrt(st.x[i] * st.x[i] + st.y[i] * st.y[i] + st.z[i] * st.z[i]);
      var band = PURE.bandOf(st.mag[i]);
      var bucket = PURE.bucketOf(st.ci[i]);
      /* row 3 is the spiked cell. The threshold widened from 0.5 to 1.6 for
         the wallpaper look: about fifty stars instead of a handful. The cell
         is still 32 px and still drawn at 16, so the spikes still fit. */
      var row = (typeof st.mag[i] === 'number' && st.mag[i] < 1.6) ? 3 : band;
      starCellX[i] = bucket * 32;
      starCellY[i] = row * 32;
      bandLists[band].push(i);
    }
    for (i = 0; i < 3; i++) bandLists[i] = new Uint32Array(bandLists[i]);
    if (SD.planets) {
      var pl = SD.planets;
      for (i = 0; i < pl.name.length; i++) {
        var h = pl.host[i];
        if (!starPlanets[h]) starPlanets[h] = [];
        starPlanets[h].push(i);
      }
    }
  })();

  function starName(i) { return SD.stars.name[i]; }
  function starIndexByName(name) {
    if (!SD) return -1;
    var i;
    for (i = 0; i < NS; i++) if (SD.stars.name[i] === name) return i;
    var ln = String(name).toLowerCase();
    for (i = 0; i < NS; i++) if (SD.stars.name[i].toLowerCase() === ln) return i;
    return -1;
  }
  function exoIndexByName(name) {
    if (!SD || !SD.planets) return -1;
    var pl = SD.planets, i;
    for (i = 0; i < pl.name.length; i++) if (pl.name[i] === name) return i;
    var ln = String(name).toLowerCase();
    for (i = 0; i < pl.name.length; i++) if (pl.name[i].toLowerCase() === ln) return i;
    return -1;
  }
  function exoObj(j) {
    var pl = SD.planets;
    return { name: pl.name[j], host: pl.host[j], per: pl.per[j], a: pl.a[j],
             rade: pl.rade[j], masse: pl.masse[j], eqt: pl.eqt[j],
             year: pl.year[j], method: pl.method[j] };
  }
  /* Prefer the archive-measured teff/lum shipped for exoplanet hosts; fall
     back to the ci/absmag estimates for HYG-only stars. A star with neither
     ci nor teff has NO temperature (NaN) and the card must not invent one. */
  function starTempOf(i) {
    var tf = SD.stars.teff && SD.stars.teff[i];
    if (typeof tf === 'number' && isFinite(tf)) return tf;
    if (SD.stars.ci[i] == null) return NaN;
    return A.starTempFromCi(SD.stars.ci[i]);
  }
  function starBolLum(i) {
    var lm = SD.stars.lum && SD.stars.lum[i];
    return A.starBolLum(lm, SD.stars.absmag[i], starTempOf(i));
  }
  function exoInHz(j, starIdx) {
    var a = SD.planets.a[j];
    if (a == null || !isFinite(a)) return false;
    var hz = A.hzBand(starBolLum(starIdx));
    return a >= hz.rIn && a <= hz.rOut;
  }

  var searchEntries = PURE.buildSearchEntries(SD, PLANET_LABELS);

  /* ---------------- procedural art libraries ---------------- */
  var ART = window.VoyageArt || null;
  var SHIPS = window.VoyageShips || null;
  var SHIP_LIST = (SHIPS && SHIPS.SHIPS) ? SHIPS.SHIPS : null;
  var starArtCache = {}, exoArtCache = {}, solArtCache = {};

  /* voyage-gl.js and voyage-galaxy.js are looked up at EVERY use site, never
     captured here. Capturing once was the real failure mode behind the tag
     order: a file that lands after this one would leave the reference null
     and the whole pass would silently no-op with every test still green. */
  var glOff = false;                    /* __voy.glDisable(), session-long */
  function GL() { return glOff ? null : (window.VoyageGL || null); }
  function GAL() { return window.VoyageGalaxy || null; }

  /* Every orb on the page goes through these two, so the GL boundary lives
     in exactly one place. GL renders the disc and returns false whenever it
     declines (radius under 40 px, this frame's two blits already spent, a
     pulsar or an unknown-temperature star, no WebGL at all) and VoyageArt
     picks it up unchanged. `allowGl` is false for the bodies D1 keeps on
     VoyageArt forever: the exoplanet orbs, and the DOM preview canvases,
     which paint outside the main rAF task where the GL buffer is readable. */
  /* The orb clock. VoyageGL pins tSec at 0 under reduced motion and renders
     exactly once; VoyageArt has no such rule and would keep animating, so
     the two renderers would disagree about whether the surface moves. The
     page settles it here, the same way stepPreviews already does. */
  function orbT(nowMs) { return reduced ? 0 : nowMs / 1000; }

  function orbDrawStar(g, x, y, r, sp, tSec, opts, allowGl) {
    if (allowGl) {
      var G = GL();
      if (G && G.drawStar) {
        try { if (G.drawStar(g, x, y, r, sp, tSec, opts)) return true; }
        catch (e) { /* fall through to the art path; never kill the frame */ }
      }
    }
    if (ART) ART.drawStar(g, x, y, r, sp, tSec, opts);
    return false;
  }
  function orbDrawPlanet(g, x, y, r, pp, tSec, opts, allowGl) {
    if (allowGl) {
      var G = GL();
      if (G && G.drawPlanet) {
        try { if (G.drawPlanet(g, x, y, r, pp, tSec, opts)) return true; }
        catch (e) { /* same rule: the art path is always a valid answer */ }
      }
    }
    if (ART) ART.drawPlanet(g, x, y, r, pp, tSec, opts);
    return false;
  }

  function starArtOf(i) {
    if (!ART || !SD || i < 0 || i >= NS) return null;
    if (starArtCache[i]) return starArtCache[i];
    var st = SD.stars;
    var p = ART.starParams({
      sp: st.sp[i], teff: starTempOf(i), ci: st.ci[i],
      absmag: st.absmag[i], lum: st.lum ? st.lum[i] : null, name: st.name[i]
    });
    starArtCache[i] = p;
    return p;
  }
  function exoArtOf(j) {
    if (!ART || !SD || !SD.planets) return null;
    if (exoArtCache[j]) return exoArtCache[j];
    var pl = SD.planets, h = pl.host[j];
    var p = ART.exoParams({
      rade: pl.rade[j], masse: pl.masse[j], eqt: pl.eqt[j], a: pl.a[j],
      hostTeff: starTempOf(h), inHz: exoInHz(j, h)
    });
    exoArtCache[j] = p;
    return p;
  }
  function solArtOf(pi) {
    if (!ART || pi < 0 || pi > 7) return null;
    var k = PLANET_KEYS[pi];
    if (!solArtCache[k]) solArtCache[k] = ART.planetParams(k);
    return solArtCache[k];
  }
  function shipKeyOf(idx) {
    if (SHIP_LIST && SHIP_LIST[idx]) return SHIP_LIST[idx].key;
    return ['ion', 'fusion', 'anti'][clampN(idx | 0, 0, 2)];
  }
  /* the honesty line every exoplanet impression carries, verbatim */
  var EXO_IMPRESSION =
    'an impression drawn from its measured size and temperature; nobody has ' +
    'seen this planet up close.';

  /* ---------------- the persistent ship ---------------- */
  var SHIP_KEY = 'voy-ship-at';
  var shipAt = { kind: 'p', idx: 2 };      /* starts in Earth orbit */
  (function loadShipAt() {
    var raw = null;
    try { raw = window.sessionStorage ? sessionStorage.getItem(SHIP_KEY) : null; } catch (e4) { raw = null; }
    var o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e5) { o = null; } }
    shipAt = PURE.normShipAt(o, PLANET_KEYS.length, NS);
    if (shipAt.kind === 's' && NS === 0) shipAt = { kind: 'p', idx: 2 };
  })();
  function saveShipAt() {
    try {
      if (window.sessionStorage) sessionStorage.setItem(SHIP_KEY, JSON.stringify(shipAt));
    } catch (e6) { /* private mode: the ship still lives in memory */ }
  }
  function shipLabel() {
    if (shipAt.kind === 'p') return PLANET_LABELS[shipAt.idx];
    return (SD && shipAt.idx < NS) ? starName(shipAt.idx) : 'Earth';
  }
  /* world position of whatever the ship is orbiting, in AU */
  var SHIP_POS = { x: 0, y: 0, z: 0 };
  function shipBodyPos(out) {
    var o = out || SHIP_POS;
    if (shipAt.kind === 'p') {
      var st = A.planetState(PLANET_KEYS[shipAt.idx], viewJD);
      o.x = st.r[0]; o.y = st.r[1]; o.z = st.r[2];
    } else {
      o.x = starX[shipAt.idx]; o.y = starY[shipAt.idx]; o.z = starZ[shipAt.idx];
    }
    return o;
  }

  /* ---------------- camera + projection ---------------- */
  var cam = {
    yaw: -0.9, pitch: 0.35, logD: Math.log(15) / Math.LN10,
    cx: 0, cy: 0, cz: 0,
    ppx: 0, ppy: 0,                      /* principal point (screen center) */
    /* D2 / CL-08. null in every mode but cruise. When it is null the basis
       derivation below is EXACTLY what it always was and projectPt is
       bit-identical to the pre-wave-4 build; when the cruise rig sets it,
       the yaw/pitch pair is bypassed entirely and the eye sits at cam.c*.
       That is what lets the flip roll the whole sky: a yaw and a pitch
       cannot express roll, and the +/-z pole is degenerate for them. */
    basis: null
  };
  var camAnim = null;                    /* {t0, ms, from, to} */
  var FOV_T = Math.tan(27.5 * DEG);      /* fov ~55 degrees */
  /* per-frame basis */
  var camD = 15, fpxV = 500, nearD = 1e-4;
  var camPX = 0, camPY = 0, camPZ = 0;   /* camera position, absolute AU */
  var fX = 0, fY = 0, fZ = 0, rX = 0, rY = 0, rZ = 0, uX = 0, uY = 0, uZ = 0;

  function explorePP() { return { x: W / 2, y: H * 0.5 }; }

  function updateCamBasis() {
    camD = Math.pow(10, cam.logD);
    fpxV = (H * 0.5) / FOV_T;
    nearD = Math.max(1e-6, camD * 1e-3);
    var b = cam.basis;
    if (b) {
      /* the rig owns the whole frame: eye exactly at cam.c*, orthonormal
         basis copied straight in, no yaw/pitch derivation and no clamp */
      camPX = cam.cx; camPY = cam.cy; camPZ = cam.cz;
      fX = b.fX; fY = b.fY; fZ = b.fZ;
      rX = b.rX; rY = b.rY; rZ = b.rZ;
      uX = b.uX; uY = b.uY; uZ = b.uZ;
      return;
    }
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var dX = cp * cy, dY = cp * sy, dZ = sp;      /* center -> camera direction */
    camPX = cam.cx + camD * dX;
    camPY = cam.cy + camD * dY;
    camPZ = cam.cz + camD * dZ;
    fX = -dX; fY = -dY; fZ = -dZ;                 /* forward */
    /* right = normalize(cross(forward, worldUp z)) */
    var rx = fY * 1 - fZ * 0, ry = fZ * 0 - fX * 1, rz = 0;
    rx = fY; ry = -fX; rz = 0;
    var rn = Math.sqrt(rx * rx + ry * ry) || 1;
    rX = rx / rn; rY = ry / rn; rZ = 0;
    /* up = cross(right, forward) */
    uX = rY * fZ - rZ * fY;
    uY = rZ * fX - rX * fZ;
    uZ = rX * fY - rY * fX;
  }

  var PRJ = { x: 0, y: 0, z: 0 };        /* reusable projection result */
  function projectPt(x, y, z, out) {
    var px = x - camPX, py = y - camPY, pz = z - camPZ;
    var zc = px * fX + py * fY + pz * fZ;
    if (zc <= nearD) return false;
    var s = fpxV / zc;
    out.x = cam.ppx + (px * rX + py * rY + pz * rZ) * s;
    out.y = cam.ppy - (px * uX + py * uY + pz * uZ) * s;
    out.z = zc;
    return true;
  }
  function camZ(x, y, z) {
    return (x - camPX) * fX + (y - camPY) * fY + (z - camPZ) * fZ;
  }
  /* project a segment with near-plane clipping; returns false if fully behind */
  var SEGA = { x: 0, y: 0, z: 0 }, SEGB = { x: 0, y: 0, z: 0 };
  function projectSeg(ax, ay, az, bx, by, bz) {
    var za = camZ(ax, ay, az), zb = camZ(bx, by, bz);
    var lim = nearD * 1.01;
    if (za <= lim && zb <= lim) return false;
    var t;
    if (za <= lim) {
      t = (lim - za) / (zb - za);
      ax += (bx - ax) * t; ay += (by - ay) * t; az += (bz - az) * t;
    } else if (zb <= lim) {
      t = (lim - zb) / (za - zb);
      bx += (ax - bx) * t; by += (ay - by) * t; bz += (az - bz) * t;
    }
    return projectPt(ax, ay, az, SEGA) && projectPt(bx, by, bz, SEGB);
  }

  /* Zoom floor. The solar-system view stops at 3.2 AU as it always has, but
     once the camera is parked on a star its planets can sit 0.03 AU out, so
     a close-up is allowed all the way down to 0.1 AU. Without this an
     exoplanet system like TRAPPIST-1 is a 17 px smudge. */
  function minLogD() { return centeredStar >= 0 ? -1.0 : 0.5; }
  var MAX_LOGD = 10.1;

  function camSnapshot() {
    return { yaw: cam.yaw, pitch: cam.pitch, logD: cam.logD,
             cx: cam.cx, cy: cam.cy, cz: cam.cz, ppx: cam.ppx, ppy: cam.ppy };
  }
  function camApply(s) {
    cam.yaw = s.yaw; cam.pitch = s.pitch; cam.logD = s.logD;
    cam.cx = s.cx; cam.cy = s.cy; cam.cz = s.cz;
    cam.ppx = s.ppx; cam.ppy = s.ppy;
  }
  function camGo(to, ms) {
    /* Anything the caller leaves out keeps its PENDING value, not the value
       the camera happens to be passing through right now: a second camGo that
       only asks for a new zoom (the exoplanet framing) must not cancel the
       fly-to-the-host-star that is still in the air. */
    var b = camAnim ? camAnim.to : cam;
    var full = {
      yaw: (to.yaw != null) ? to.yaw : b.yaw,
      pitch: (to.pitch != null) ? to.pitch : b.pitch,
      logD: (to.logD != null) ? clampN(to.logD, minLogD(), MAX_LOGD) : b.logD,
      cx: (to.cx != null) ? to.cx : b.cx,
      cy: (to.cy != null) ? to.cy : b.cy,
      cz: (to.cz != null) ? to.cz : b.cz,
      ppx: (to.ppx != null) ? to.ppx : b.ppx,
      ppy: (to.ppy != null) ? to.ppy : b.ppy
    };
    if (reduced || ms === 0) { camApply(full); camAnim = null; return; }
    camAnim = { t0: performance.now(), ms: ms || 1200, from: camSnapshot(), to: full };
  }
  function camStep(now) {
    if (!camAnim) return;
    var k = clampN((now - camAnim.t0) / camAnim.ms, 0, 1);
    var e = easeInOutCubic(k);
    var f = camAnim.from, t = camAnim.to;
    cam.yaw = f.yaw + (t.yaw - f.yaw) * e;
    cam.pitch = f.pitch + (t.pitch - f.pitch) * e;
    cam.logD = f.logD + (t.logD - f.logD) * e;
    cam.cx = f.cx + (t.cx - f.cx) * e;
    cam.cy = f.cy + (t.cy - f.cy) * e;
    cam.cz = f.cz + (t.cz - f.cz) * e;
    cam.ppx = f.ppx + (t.ppx - f.ppx) * e;
    cam.ppy = f.ppy + (t.ppy - f.ppy) * e;
    if (k >= 1) camAnim = null;
  }

  function zoomTargetD(starIdx) {
    var list = starPlanets[starIdx];
    if (list && list.length) {
      var maxA = 0, j;
      for (j = 0; j < list.length; j++) {
        var a = SD.planets.a[list[j]];
        if (a == null || !isFinite(a)) {
          var per = SD.planets.per[list[j]];
          if (per != null && isFinite(per) && per > 0) a = Math.pow(per / 365.25, 2 / 3);
        }
        if (a != null && isFinite(a) && a > maxA) maxA = a;
      }
      if (maxA > 0) return clampN(22 * maxA, 0.6, 160);
    }
    return 3;
  }
  function flyToStar(i, instant) {
    centeredStar = i;
    var pp = explorePP();
    camGo({ cx: starX[i], cy: starY[i], cz: starZ[i],
            logD: Math.log(zoomTargetD(i)) / Math.LN10,
            ppx: pp.x, ppy: pp.y }, instant ? 0 : 1200);
  }
  function flyToPlanet(pi, instant) {
    centeredStar = -1;
    var st = A.planetState(PLANET_KEYS[pi], viewJD);
    var el = A.ELEMENTS[PLANET_KEYS[pi]];
    var pp = explorePP();
    camGo({ cx: st.r[0], cy: st.r[1], cz: st.r[2],
            logD: Math.log(Math.max(0.35, el.a0 * 0.4)) / Math.LN10,
            ppx: pp.x, ppy: pp.y }, instant ? 0 : 1200);
  }
  function flyHome(instant) {
    centeredStar = -1;
    var pp = explorePP();
    camGo({ cx: 0, cy: 0, cz: 0, logD: Math.log(15) / Math.LN10, ppx: pp.x, ppy: pp.y },
          instant ? 0 : 1200);
  }

  /* ---------------- sprites ---------------- */
  var atlas = { dark: null, light: null };
  var BAND_A = [1, 0.85, 0.6];
  var BAND_R = [3.3, 2.35, 1.65];

  function bucketRgb(b) {
    var ci = -0.4 + (b + 0.5) * 0.15;
    return A.kelvinToRgb(A.starTempFromCi(ci));
  }
  function ensureAtlas() {
    var key = isLight() ? 'light' : 'dark';
    if (atlas[key]) return atlas[key];
    var light = key === 'light';
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    var g = cv.getContext('2d');
    var b, row;
    for (b = 0; b < 16; b++) {
      var c = bucketRgb(b);
      var cr = c.r, cg = c.g, cb = c.b;
      if (light) { cr = Math.round(cr * 0.52); cg = Math.round(cg * 0.52); cb = Math.round(cb * 0.55); }
      for (row = 0; row < 4; row++) {
        var rr = BAND_R[row === 3 ? 0 : row];
        var cx0 = b * 32 + 16, cy0 = row * 32 + 16;
        var grad = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, rr * 2.6);
        var core = light ? 'rgba(' + Math.round(cr * 0.7) + ',' + Math.round(cg * 0.7) + ',' + Math.round(cb * 0.7) + ',1)'
                         : 'rgba(255,255,255,0.95)';
        grad.addColorStop(0, core);
        grad.addColorStop(0.3, 'rgba(' + cr + ',' + cg + ',' + cb + ',0.9)');
        grad.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx0, cy0, rr * 2.6, 0, 6.2832); g.fill();
        if (row === 3) {
          /* four tiny diffraction spikes, pre-rendered (mag < 1.6 stars).
             A camera effect, not starlight; the page says so. */
          g.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.6)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(cx0 - 14, cy0 + 0.5); g.lineTo(cx0 + 14, cy0 + 0.5);
          g.moveTo(cx0 + 0.5, cy0 - 14); g.lineTo(cx0 + 0.5, cy0 + 14);
          g.stroke();
        }
      }
    }
    atlas[key] = cv;
    return cv;
  }

  /* ==================================================================
     The galaxy: a WORLD-SPACE point cloud, not a billboard.
     Generated once (seeded), in GALACTIC cartesian light-years centred on
     the Sun, then rotated galactic -> equatorial -> ecliptic and scaled to
     AU. Because every point is a real world position, orbiting the camera
     moves the galaxy like a structure instead of like wallpaper.
     ================================================================== */
  var GAL_R0_LY = 26000;                 /* Sun to the galactic centre */
  var GAL_R_LY = 50000;                  /* drawn disc radius */
  var GAL_N = 22000, GAL_HALO = 600;
  var galCloud = null;                   /* {n, x, y, z (AU), tint(Uint8Array)} */

  /* the galactic centre in ecliptic AU, from the pinned J2000 frame */
  var GC = (function () {
    var e = A.equToEcl(PURE.galToEqu(1, 0, 0));
    var d = GAL_R0_LY * LY_AU;
    return { x: e[0] * d, y: e[1] * d, z: e[2] * d };
  })();
  var GAL_R_AU = GAL_R_LY * LY_AU;

  function buildGalaxy() {
    if (galCloud) return galCloud;
    var n = GAL_N + GAL_HALO;
    var gx = new Float64Array(n), gy = new Float64Array(n), gz = new Float64Array(n);
    var tint = new Uint8Array(n);
    var rnd = mulberry32(20260727);
    var eqv = [0, 0, 0];
    var i, R, phi, zz, kind, t;
    var BAR_ANG = 0.44;                  /* the bar leads the Sun-centre line */
    function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) * 0.7071; }
    function place(idx, R, phi, zz, tn) {
      /* galactocentric -> heliocentric galactic: the Sun sits R0 from the
         centre along -x, so the centre itself lands at (+R0, 0, 0). */
      var hx = GAL_R0_LY + R * Math.cos(phi);
      var hy = R * Math.sin(phi);
      PURE.galToEqu(hx, hy, zz, eqv);
      var e = A.equToEcl(eqv);
      gx[idx] = e[0] * LY_AU; gy[idx] = e[1] * LY_AU; gz[idx] = e[2] * LY_AU;
      tint[idx] = tn;
    }
    for (i = 0; i < GAL_N; i++) {
      var u = rnd();
      if (u < 0.20) {
        /* bulge: round, thick, warm */
        R = Math.abs(gauss()) * 2600;
        if (R > 7000) R = 7000;
        phi = rnd() * 6.2832;
        zz = gauss() * 3000 * 0.5;
        kind = 0;
      } else if (u < 0.30) {
        /* bar */
        t = (rnd() * 2 - 1);
        var bl = t * 5200, bw = gauss() * 900;
        var bx = bl * Math.cos(BAR_ANG) - bw * Math.sin(BAR_ANG);
        var by = bl * Math.sin(BAR_ANG) + bw * Math.cos(BAR_ANG);
        R = Math.sqrt(bx * bx + by * by);
        phi = Math.atan2(by, bx);
        zz = gauss() * 900;
        kind = 0;
      } else if (u < 0.90) {
        /* four log-spiral arms */
        var arm = (rnd() * 4) | 0;
        t = Math.pow(rnd(), 0.72);
        R = 3200 + t * (GAL_R_LY - 3200);
        var pitch = 4.3;                 /* radians per e-fold of radius */
        phi = arm * (Math.PI / 2) + BAR_ANG + pitch * Math.log(R / 3200) / Math.LN10;
        phi += gauss() * 0.22;
        R *= 1 + gauss() * 0.05;
        zz = gauss() * 1000 * 0.6;
        /* a slice of arm points is dimmed, which reads as dust lanes */
        kind = rnd() < 0.30 ? 2 : 1;
      } else {
        /* smooth disc between the arms */
        R = -8000 * Math.log(1 - rnd() * 0.995);
        if (R > GAL_R_LY) R = GAL_R_LY;
        phi = rnd() * 6.2832;
        zz = gauss() * 1000 * 0.6;
        kind = 2;
      }
      if (!isFinite(R) || !isFinite(phi) || !isFinite(zz)) { R = 0; phi = 0; zz = 0; }
      place(i, R, phi, zz, kind);
    }
    for (i = 0; i < GAL_HALO; i++) {
      R = 6000 + Math.pow(rnd(), 0.6) * 54000;
      phi = rnd() * 6.2832;
      var ct = rnd() * 2 - 1;
      zz = R * ct;
      R = R * Math.sqrt(Math.max(0, 1 - ct * ct));
      place(GAL_N + i, R, phi, zz, 0);
    }
    /* Counting-sort the cloud into three contiguous tint runs. The draw pass
       then walks each run once instead of walking all 22,600 points three
       times looking for its own colour. */
    var cnt = [0, 0, 0], b;
    for (i = 0; i < n; i++) cnt[tint[i]]++;
    var start = [0, cnt[0], cnt[0] + cnt[1]];
    var cur = [start[0], start[1], start[2]];
    var sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
    var st2 = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      b = tint[i];
      var d = cur[b]++;
      sx[d] = gx[i]; sy[d] = gy[i]; sz[d] = gz[i]; st2[d] = b;
    }
    galCloud = { n: n, x: sx, y: sy, z: sz, tint: st2,
                 start: start, end: [start[1], start[2], n] };
    return galCloud;
  }

  /* three tint buckets: warm bulge/bar/halo, blue-white arms, dim disc */
  var GAL_TINT_D = ['rgb(236,214,170)', 'rgb(198,214,242)', 'rgb(150,166,198)'];
  var GAL_TINT_L = ['rgb(150,116,44)', 'rgb(60,84,128)', 'rgb(96,112,140)'];
  var GAL_ALPHA = [0.55, 0.42, 0.20];
  var GAL_SIZE = [2.0, 1.8, 1.5];

  /* ---------------- layout (porkchop rects; ported from mars.js) -------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!cam.ppx && !cam.ppy) { cam.ppx = W / 2; cam.ppy = H * 0.5; }
  }

  function chatClearance() {
    var el = document.getElementById('chat-widget');
    if (!el) return 16;
    var r = el.getBoundingClientRect();
    if (!r.height || r.top >= H) return 16;
    return Math.max(16, Math.round(H - r.top) + 8);
  }

  function cornerBand() {
    var els = [document.getElementById('theme-toggle'), document.getElementById('life-link')];
    var top = Infinity, bot = -Infinity;
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      var r = els[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bot) bot = r.bottom;
    }
    if (!isFinite(top)) return { top: H - 110, bottom: H - 60 };
    return { top: top, bottom: bot };
  }

  function layout() {
    var mobile = W < 1000;
    var phone = W < 600 && H >= 560;
    var shortWide = !phone && H < 520 && W >= 520 && W < 1000;
    var panelReserve = (W >= 600 && panelOpen) ? 330 : 0;
    var botClear = chatClearance();
    var pc, plot, ro, tl;
    if (!mobile) {
      var pcW = Math.min(Math.round(W * 0.40), 460);
      var plotH = Math.round(pcW * 0.58);
      var roH = 92;
      var pcH = plotH + roH;
      pc = { x: W - pcW - panelReserve, y: H - pcH - botClear, w: pcW, h: pcH };
      ro = { x: pc.x, y: pc.y, w: pcW, h: roH };
      plot = { x: pc.x + 48, y: pc.y + roH + 4, w: pcW - 48 - 14, h: plotH - 4 - 26 };
      tl = { x0: 140, x1: Math.max(260, pc.x - 26), y: H - 26 };
    } else if (phone) {
      var band = cornerBand();
      var pcH3 = Math.round(H * 0.42);
      pc = { x: 6, y: H - pcH3 - Math.max(8, botClear - 8), w: W - 12, h: pcH3 };
      ro = { x: pc.x, y: pc.y + pc.h - 52, w: pc.w, h: 52 };
      var plotTop = pc.y + 8;
      var plotBot = Math.min(band.top - 30, ro.y - 26);
      plot = { x: pc.x + 44, y: plotTop, w: pc.w - 44 - 10, h: Math.max(90, plotBot - plotTop) };
      tl = { x0: 16, x1: W - 16, y: pc.y - 22 };
    } else if (shortWide) {
      var pcW2 = Math.round(Math.min(W * 0.56, W - panelReserve - 200));
      var pcX = Math.max(140, W - pcW2 - 8 - panelReserve);
      var top2 = 118;
      if (elPanel) {
        var pr = elPanel.getBoundingClientRect();
        if (pr.height && pr.right > pcX && pr.left < pcX + pcW2) {
          top2 = Math.min(Math.round(H * 0.45), Math.max(top2, Math.round(pr.bottom) + 6));
        }
      }
      pc = { x: pcX, y: top2, w: pcW2, h: H - top2 - 10 };
      ro = { x: pc.x, y: pc.y + pc.h - 46, w: pc.w, h: 46 };
      plot = { x: pc.x + 44, y: pc.y + 8, w: pc.w - 44 - 12, h: Math.max(60, pc.h - 8 - 46 - 22) };
      tl = { x0: 140, x1: Math.max(240, pc.x - 20), y: H - 26 };
    } else {
      /* Docked along the bottom. The plot starts at pc.x + 134 so taps never
         land on the fixed corner buttons (#theme-toggle, #life-link). */
      var pcH2 = Math.round(H * 0.38);
      pc = { x: 6, y: H - pcH2 - Math.max(8, botClear - 8), w: W - 12 - panelReserve, h: pcH2 };
      ro = { x: pc.x, y: pc.y, w: pc.w, h: 46 };
      plot = { x: pc.x + 134, y: pc.y + 50, w: pc.w - 134 - 10, h: pc.h - 50 - 24 };
      tl = { x0: 140, x1: W - 16 - panelReserve, y: pc.y - 22 };
    }
    L = { mobile: mobile, phone: phone, side: shortWide, reserve: panelReserve,
          pc: pc, plot: plot, ro: ro, tl: tl };
    if (mode === 'porkchop' && !camAnim) {
      var fit = fitPork();
      cam.logD = fit.logD; cam.ppx = fit.ppx; cam.ppy = fit.ppy;
    }
  }

  /* top-down camera fit for porkchop mode: the free area left of the panel
     and above the plot (the docked branch must also clear the panel) */
  function fitPork() {
    var elE = A.elementsRad('earth', jdToday);
    var elT = A.elementsRad(pcTarget, jdToday);
    var rFit = Math.max(elE.a * (1 + elE.e), elT.a * (1 + elT.e)) * 1.12;
    var x0 = 10;
    var x1 = (L.mobile && !L.side) ? Math.max(x0 + 60, W - 10 - L.reserve)
                                   : Math.max(x0 + 60, L.pc.x - 10);
    var y0 = Math.max(90, H * 0.16), y1 = L.tl.y - 30;
    if (y1 < y0 + 60) y1 = y0 + 60;
    var half = Math.max(40, Math.min(x1 - x0, y1 - y0) / 2);
    var fpx = (H * 0.5) / FOV_T;
    return {
      logD: Math.log(Math.max(1, fpx * rFit / half)) / Math.LN10,
      ppx: (x0 + x1) / 2, ppy: (y0 + y1) / 2
    };
  }

  /* ---------------- orbit caches ---------------- */
  var orbitPts = {};
  function orbitOf(key) {
    if (!orbitPts[key]) {
      var pts = A.orbitPoints(key, jdToday, 128);
      var flat = new Float64Array(pts.length * 3);
      for (var k = 0; k < pts.length; k++) {
        flat[k * 3] = pts[k][0]; flat[k * 3 + 1] = pts[k][1]; flat[k * 3 + 2] = pts[k][2];
      }
      orbitPts[key] = flat;
    }
    return orbitPts[key];
  }

  /* ---------------- porkchop machinery (ported from mars.js) ------------ */
  function specOf(key) {
    if (!specs[key]) specs[key] = A.porkchopSpec(key, jd0);
    return specs[key];
  }
  function tlRange() {
    var sp = specOf(pcTarget);
    return { min: sp.jd0, max: sp.depMax + sp.tofMax };
  }
  function selInfo() {
    var s = pcSel[pcTarget];
    if (!s) return null;
    var sp = specOf(pcTarget);
    var dep = sp.jd0 + s.i * sp.depStep;
    var tof = sp.tof0 + s.j * sp.tofStep;
    var key = pcTarget + ':' + s.i + ':' + s.j;
    if (!(key in readoutCache)) readoutCache[key] = A.missionDv(dep, tof, pcTarget);
    return { dep: dep, tof: tof, m: readoutCache[key] };
  }
  function updateGhost(info) {
    if (!info || !info.m) { ghost = null; return; }
    var NP = 72, pts = [];
    for (var k = 0; k <= NP; k++) {
      pts.push(A.propagateKepler(info.m.rDep, info.m.v1, info.tof * k / NP).r);
    }
    ghost = { pts: pts, dep: info.dep, arr: info.dep + info.tof, rDep: info.m.rDep, rArr: info.m.rArr };
  }
  function pcLiveStatus(info) {
    if (!info) return;
    var txt = info.m
      ? ('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days · ' + info.m.total.toFixed(1) + ' km/s total')
      : 'No transfer solution at this spot.';
    liveStatusText(txt);
  }
  function setPcSel(i, j, force) {
    var s = pcSel[pcTarget];
    if (s && s.i === i && s.j === j && !force) return;
    pcSel[pcTarget] = { i: i, j: j };
    cancelPcCruise();
    arrivedPulse = 0;
    if (btnLaunch) btnLaunch.textContent = 'Launch';
    var info = selInfo();
    if (info) {
      viewJD = info.dep;
      updateGhost(info);
      pcLiveStatus(info);
    }
  }
  function cancelPcCruise() {
    if (pcCruise) pcCruise = null;
  }
  function announceArrival(info) {
    setStatus('Arrived ' + fmtDate(info.dep + info.tof) + ' · ' + info.tof + ' days · ' +
              info.m.total.toFixed(1) + ' km/s total');
  }
  function pcTargetIdx() { return PLANET_KEYS.indexOf(pcTarget); }
  function pcArrive(info) {
    shipAt = { kind: 'p', idx: pcTargetIdx() };
    saveShipAt();
    updateTargetLine();
  }
  function pcLaunch() {
    var info = selInfo();
    if (!info) { setStatus('Pick a spot on the map first.'); return; }
    if (!info.m) { setStatus('No transfer solution here. Pick a brighter cell.'); return; }
    if (shipAt.kind === 'p' && shipAt.idx === pcTargetIdx()) {
      setStatus('You are already there.');
      return;
    }
    attract = false;
    arrivedPulse = 0;
    if (reduced) {
      cancelPcCruise();
      viewJD = info.dep + info.tof;
      pcArrive(info);
      announceArrival(info);
      if (btnLaunch) btnLaunch.textContent = 'Replay';
      return;
    }
    pcCruise = { info: info, t0: performance.now(), ms: 8000, trail: [] };
    setStatus('Cruising to ' + PLANET_LABELS[pcTargetIdx()] +
              '. The engines fire at each end and the ship coasts in between.');
    if (btnLaunch) btnLaunch.textContent = 'Launch';
  }
  function nextWindow() {
    var job = jobs[pcTarget];
    if (!job || !job.done) { setStatus('Still computing the map. One moment.'); return; }
    attract = false;
    var sp = specOf(pcTarget);
    var s = pcSel[pcTarget];
    var curDep = s ? sp.jd0 + s.i * sp.depStep : -Infinity;
    var limit = curDep + 200;
    var best = null, bestDv = Infinity, gbest = null, gbestDv = Infinity;
    for (var i = 0; i < sp.nDep; i++) {
      var dep = sp.jd0 + i * sp.depStep;
      for (var j = 0; j < sp.nTof; j++) {
        var dv = job.total[i * sp.nTof + j];
        if (!isFinite(dv)) continue;
        if (dv < gbestDv) { gbestDv = dv; gbest = { i: i, j: j }; }
        if (dep > limit && dv < bestDv) { bestDv = dv; best = { i: i, j: j }; }
      }
    }
    var pick = best || gbest;
    if (!pick) return;
    setPcSel(pick.i, pick.j, true);
    var name = PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)];
    var months = Math.round(A.synMonths(pcTarget));
    var info = selInfo();
    ariaLast = performance.now();
    ariaPend = null;
    setStatus('Earth and ' + name + ' line up like this about every ' + months + ' months.' +
      (info && info.m ? (' Depart ' + fmtDate(info.dep) + ' · ' + info.m.total.toFixed(1) + ' km/s total.') : ''));
  }

  function renderPcCache() {
    var job = jobs[pcTarget];
    if (!job || !L) return;
    var sp = job.spec, n = sp.nDep, m = sp.nTof;
    var cw = Math.max(2, Math.round(L.plot.w * dpr));
    var chh = Math.max(2, Math.round(L.plot.h * dpr));
    if (!pcCache) pcCache = document.createElement('canvas');
    if (pcCache.width !== cw || pcCache.height !== chh) { pcCache.width = cw; pcCache.height = chh; }
    var g = pcCache.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, chh);

    var light = isLight();
    var cell = document.createElement('canvas');
    cell.width = n; cell.height = m;
    var cg = cell.getContext('2d');
    var img = cg.createImageData(n, m);
    var i, j, idx;
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;
        var p = ((m - 1 - j) * n + i) * 4;
        var dv = job.total[idx];
        if (isNaN(dv)) {
          img.data[p] = 127; img.data[p + 1] = 127; img.data[p + 2] = 127;
          img.data[p + 3] = light ? 34 : 46;
        } else {
          var c = dvColor(dv, light);
          img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
          img.data[p + 3] = 255;
        }
      }
    }
    cg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(cell, 0, 0, n, m, 0, 0, cw, chh);
    cell.width = 0;

    var sx = cw / n, sy = chh / m;
    g.strokeStyle = light ? 'rgba(255,255,255,0.55)' : 'rgba(10,12,16,0.5)';
    g.lineWidth = Math.max(1, 0.7 * dpr);
    g.beginPath();
    function band(q) { var v = job.total[q]; return isNaN(v) ? -999 : Math.floor(Math.min(14, v)); }
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;
        var b0 = band(idx);
        if (b0 === -999) continue;
        if (i + 1 < n && (i + 1) * m + j < job.doneCount) {
          var b1 = band((i + 1) * m + j);
          if (b1 !== -999 && b1 !== b0) {
            var xv = (i + 1) * sx, yv = (m - 1 - j) * sy;
            g.moveTo(xv, yv); g.lineTo(xv, yv + sy);
          }
        }
        if (j + 1 < m && idx + 1 < job.doneCount) {
          var b2 = band(idx + 1);
          if (b2 !== -999 && b2 !== b0) {
            var yh = (m - 1 - j) * sy, xh = i * sx;
            g.moveTo(xh, yh); g.lineTo(xh + sx, yh);
          }
        }
      }
    }
    g.stroke();

    if (job.done && job.minI >= 0) {
      var mx = (job.minI + 0.5) * sx, my = (m - 1 - job.minJ + 0.5) * sy;
      g.strokeStyle = light ? 'rgba(38,38,38,0.9)' : 'rgba(233,239,246,0.95)';
      g.lineWidth = 1.4 * dpr;
      g.beginPath(); g.arc(mx, my, 5.5 * dpr, 0, 6.2832); g.stroke();
      g.font = (10.5 * dpr) + 'px ' + FONT;
      g.textBaseline = 'middle';
      var lbl = 'min ' + job.minDv.toFixed(1) + ' km/s';
      var onRight = mx < cw - 78 * dpr;
      g.textAlign = onRight ? 'left' : 'right';
      g.fillStyle = light ? 'rgba(38,38,38,0.85)' : 'rgba(233,239,246,0.9)';
      g.fillText(lbl, mx + (onRight ? 9 : -9) * dpr, my);
    }
    pcDirty = false;
  }

  /* ---------------- porkchop enter / exit ---------------- */
  function enterPorkchop(pi, instant) {
    var key = PLANET_KEYS[pi];
    if (key === 'earth') return;
    cancelStarCruise(true);
    closeCard();
    if (mode !== 'porkchop') camBefore = camSnapshot();
    pcTarget = key;
    sel = { kind: 'p', idx: pi };
    selExo = -1;
    centeredStar = -1;
    specOf(key);
    if (!jobs[key]) jobs[key] = A.makePorkchopJob(specs[key]);
    pcCache = null; pcDirty = true; lastPcPaint = 0;
    ghost = null;
    layout();                            /* mode flips after: no camera snap */
    var fit = fitPork();
    mode = 'porkchop';
    camGo({ pitch: 1.25, logD: fit.logD, cx: 0, cy: 0, cz: 0,
            ppx: fit.ppx, ppy: fit.ppy }, instant ? 0 : 1200);
    var s = pcSel[key];
    if (s) {
      var info = selInfo();
      if (info) { viewJD = info.dep; updateGhost(info); pcLiveStatus(info); }
    } else {
      var r = tlRange();
      viewJD = clampN(viewJD, r.min, Math.min(r.max, JD_2050));
      setStatus('Computing the ' + PLANET_LABELS[pi] + ' map.');
    }
    updatePanelMode();
    updateTargetLine();
  }
  function exitPorkchop() {
    if (mode !== 'porkchop') return;
    cancelPcCruise();
    mode = 'explore';
    viewJD = jdToday;   /* back to honest present-day positions */
    var pi = sel ? sel.idx : -1;
    if (camBefore) { camGo(camBefore, 1200); camBefore = null; }
    else flyHome(false);
    updatePanelMode();
    if (pi >= 0) openCardFor({ kind: 'p', idx: pi });
    setStatus('Back to the sky.');
  }
  function updatePanelMode() {
    var pk = mode === 'porkchop';
    if (elPcRow) elPcRow.hidden = !pk;
    if (elWinDetails) {
      elWinDetails.hidden = !pk;
      if (pk && pcTarget) {
        var pi = PLANET_KEYS.indexOf(pcTarget);
        var syn = Math.round(A.synMonths(pcTarget));
        var py = A.periodYears(pcTarget);
        var perTxt = (py * 12 <= 36) ? ('about ' + Math.round(py * 12) + ' months')
                                     : ('about ' + Math.round(py) + ' years');
        if (elWinSum) elWinSum.textContent = 'Why every ' + syn + ' months?';
        if (elWinText) {
          elWinText.textContent = 'Earth circles the Sun in about 12 months, ' +
            PLANET_LABELS[pi] + ' in ' + perTxt +
            '. The cheap transfer geometry only works when the two planets line up the right way, ' +
            'and that lineup repeats about every ' + syn + ' months (the synodic period). ' +
            'That is why missions leave in bunches.';
        }
      }
    }
  }

  /* ---------------- selection / cards ---------------- */
  function bodyLabel(s) {
    if (!s) return null;
    return s.kind === 'p' ? PLANET_LABELS[s.idx] : starName(s.idx);
  }
  function updateTargetLine() {
    if (!elTarget) return;
    var ship = ' Your ship is in orbit around ' + shipLabel() + '.';
    if (mode === 'porkchop' && pcTarget) {
      elTarget.textContent = 'Trip: Earth to ' +
        PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)] + '.' + ship;
      return;
    }
    if (!sel) {
      elTarget.textContent =
        'Pick a destination: tap a planet or a star, or search above.' + ship;
      return;
    }
    if (sel.kind === 'p') {
      elTarget.textContent = 'Selected: ' + PLANET_LABELS[sel.idx] + '.' + ship;
    } else {
      elTarget.textContent = 'Selected: ' + starName(sel.idx) + ' · ' +
        PURE.distPhrase(starLyD[sel.idx]) + '.' + ship;
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cardOpen() { return !!(cardEl && !cardEl.hidden); }
  function closeCard() {
    if (cardEl) { cardEl.hidden = true; cardEl.innerHTML = ''; }
    document.body.classList.remove('voy-sheet-open');
    arriveInfo = null;   /* the arrival banner is for the moment of arrival */
    resetPreviews();     /* a closed card must not keep painting offscreen */
  }

  function deselect() {
    sel = null; selExo = -1;
    closeCard();
    updateTargetLine();
  }

  function selectBody(s, opts) {
    opts = opts || {};
    cancelStarCruise(true);
    if (arriveInfo && (s.kind !== 's' || arriveInfo.star !== s.idx)) arriveInfo = null;
    if (mode === 'porkchop') { /* mutual exclusion: no cards inside porkchop */
      return;
    }
    sel = { kind: s.kind, idx: s.idx };
    if (s.kind !== 's' || opts.keepExo !== true) selExo = -1;
    if (opts.exo != null) selExo = opts.exo;
    updateTargetLine();
    if (opts.fly) {
      if (s.kind === 'p') flyToPlanet(s.idx, !!opts.instant);
      else flyToStar(s.idx, !!opts.instant);
    }
    if (opts.openCard !== false) openCardFor(sel, opts);
    var lbl = bodyLabel(sel);
    if (s.kind === 's') {
      setStatus('Selected ' + lbl + ', ' + PURE.distPhrase(starLyD[s.idx]) + ' away.');
    } else {
      setStatus('Selected ' + lbl + '.');
    }
  }

  function zoomToBody(s) {
    if (s.kind === 'p') flyToPlanet(s.idx, false);
    else flyToStar(s.idx, false);
  }

  /* ==================================================================
     Live DOM previews inside the open card: the star orb, the expanded
     exoplanet's orb, and the rocket turntable under the acceleration row.
     They render from the main rAF and ONLY while the card is open, so a
     closed card costs nothing.
     ================================================================== */
  function previewCanvas(cls, cssW, cssH) {
    var cv = document.createElement('canvas');
    cv.className = cls;
    cv.width = Math.round(cssW * Math.min(window.devicePixelRatio || 1, 2));
    cv.height = Math.round(cssH * Math.min(window.devicePixelRatio || 1, 2));
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.setAttribute('aria-hidden', 'true');
    return cv;
  }
  function prevCtx(cv) {
    var g = cv.getContext('2d');
    if (!g) return null;
    var s = Math.min(window.devicePixelRatio || 1, 2);
    g.setTransform(s, 0, 0, s, 0, 0);
    return g;
  }
  function resetPreviews() {
    previews = { star: null, exo: null, ship: null };
  }
  resetPreviews();

  function stepPreviews(now) {
    if (!previews || !cardOpen()) return;
    var t = reduced ? 0 : now / 1000;
    var p = previews.star;
    if (p && p.cv.isConnected && p.g) {
      p.g.clearRect(0, 0, p.w, p.h);
      var art = starArtOf(p.i);
      var r = Math.min(p.w, p.h) * 0.33;
      /* The card orbs go through the same two helpers as everything else,
         with GL switched OFF: these canvases paint outside the main rAF
         task, and with preserveDrawingBuffer false the GL buffer is only
         guaranteed readable inside the task that rendered it. */
      if (art) orbDrawStar(p.g, p.w / 2, p.h / 2, r, art, t, { quality: 0 }, false);
      else drawStarBlobOn(p.g, p.w / 2, p.h / 2, r, starTempOf(p.i));
    }
    p = previews.exo;
    if (p && p.cv.isConnected && p.g) {
      p.g.clearRect(0, 0, p.w, p.h);
      var eart = exoArtOf(p.j);
      if (eart) {
        orbDrawPlanet(p.g, p.w / 2, p.h / 2, Math.min(p.w, p.h) * 0.36, eart, t,
                      { quality: 0, lightDir: Math.PI * 0.85 }, false);
      }
    }
    p = previews.ship;
    /* the trip section starts collapsed behind "Plan the trip": a preview
       nobody can see must not paint */
    if (p && p.cv.isConnected && p.g && SHIPS && !(p.host && p.host.hidden)) {
      var fade = p.fadeT0 ? clampN((now - p.fadeT0) / 250, 0, 1) : 1;
      /* VoyageShips.drawShipTurntable clears first, which would wipe the
         outgoing design, so the crossfade repeats its framing by hand */
      p.g.clearRect(0, 0, p.w, p.h);
      if (fade < 1 && p.prevKey) turntableInto(p.g, p.prevKey, t, p.w, p.h, 1 - fade);
      turntableInto(p.g, p.key, t, p.w, p.h, fade);
      if (fade >= 1) { p.fadeT0 = 0; p.prevKey = null; }
    }
  }
  /* same framing as VoyageShips.drawShipTurntable, minus the clear */
  function turntableInto(g, key, t, w, h, alpha) {
    if (!SHIPS || !(w > 0) || !(h > 0)) return;
    var hh = (SHIPS.halfHeightOf ? SHIPS.halfHeightOf(key) : 0.3) || 0.3;
    var px = clampN(Math.min(w * 0.80, (h * 0.44) / hh), 12, 420);
    var thrust = 0.22 + 0.07 * (0.5 + 0.5 * Math.sin(t * 1.6));
    if (!isFinite(px) || !isFinite(thrust)) return;
    g.globalAlpha = clampN(alpha, 0, 1);
    SHIPS.drawShip(g, w * 0.54, h * 0.5, px, t * 0.5,
                   { key: key, thrust: thrust, t: t, quality: w < 150 ? 0 : 1, flip: 0,
                     light: isLight() });
    g.globalAlpha = 1;
  }
  /* the ART-less fallback, drawn onto an arbitrary context */
  function drawStarBlobOn(g, cx0, cy0, rpx, T) {
    if (!isFinite(cx0) || !isFinite(cy0) || !(rpx > 0)) return;
    var rgb = isFinite(T) ? A.kelvinToRgb(T) : { r: 214, g: 218, b: 228 };
    var grad = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, rpx * 2.2);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.28, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.9)');
    grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx0, cy0, rpx * 2.2, 0, 6.2832); g.fill();
  }

  /* ---- card builders ---- */
  function cardHead(title, sub) {
    var head = el('div', 'voy-card__head');
    var twrap = el('div', 'voy-card__titles');
    twrap.appendChild(el('span', 'voy-card__title', title));
    if (sub) twrap.appendChild(el('span', 'voy-card__sub', sub));
    head.appendChild(twrap);
    var close = el('button', 'voy-card__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { closeCard(); });
    head.appendChild(close);
    return head;
  }

  function openCardFor(s, opts) {
    opts = opts || {};
    if (!cardEl) return;
    /* on phones the card is a full-width bottom sheet; an expanded panel
       would sit on top of it, so tuck the panel away first. The body class
       hides the corner buttons under the sheet (CSS is ≤768px-scoped). */
    if (W <= 768 && panelUi && !panelUi.collapsed()) panelUi.setCollapsed(true);
    document.body.classList.add('voy-sheet-open');
    cardEl.innerHTML = '';
    resetPreviews();
    cardEl.hidden = false;
    if (s.kind === 'p') buildPlanetCard(s.idx);
    else buildStarCard(s.idx, opts);
    cardEl.setAttribute('aria-label', 'About ' + bodyLabel(s));
  }

  function buildPlanetCard(pi) {
    var key = PLANET_KEYS[pi], lbl = PLANET_LABELS[pi];
    cardEl.appendChild(cardHead(lbl, 'planet'));
    var body = el('div', 'voy-card__body');
    if (key === 'earth') {
      body.appendChild(el('p', 'voy-fact', 'You are here.'));
    } else {
      var rE = A.planetState('earth', jdToday).r;
      var rT = A.planetState(key, jdToday).r;
      var dAU = Math.sqrt(Math.pow(rT[0] - rE[0], 2) + Math.pow(rT[1] - rE[1], 2) + Math.pow(rT[2] - rE[2], 2));
      var kmM = dAU * A.AU_KM / 1e6;
      var kmTxt = kmM >= 1000 ? ('about ' + (Math.round(kmM / 100) / 10) + ' billion km')
                              : ('about ' + Math.round(kmM) + ' million km');
      body.appendChild(el('p', 'voy-fact',
        'Right now it is ' + (Math.round(dAU * 100) / 100) + ' AU from Earth, ' + kmTxt + '.'));
    }
    var py = A.periodYears(key);
    var perTxt = py * 365.25 < 800 ? (Math.round(py * 365.25) + ' days') :
      ((py < 10 ? Math.round(py * 10) / 10 : Math.round(py)) + ' years');
    body.appendChild(el('p', 'voy-fact', 'It orbits the Sun every ' + perTxt + '.'));
    var row = el('div', 'voy-actions');
    if (key !== 'earth') {
      var plan = el('button', 'voy-btn voy-btn--primary', 'Plan the trip');
      plan.type = 'button';
      plan.addEventListener('click', function () { enterPorkchop(pi, false); });
      row.appendChild(plan);
    }
    var zoom = el('button', 'voy-btn', 'Zoom to it');
    zoom.type = 'button';
    zoom.addEventListener('click', function () { flyToPlanet(pi, false); });
    row.appendChild(zoom);
    body.appendChild(row);
    cardEl.appendChild(body);
  }

  function buildStarCard(i, opts) {
    var st = SD.stars;
    var name = st.name[i];
    var sub = st.hip[i] && name !== 'HIP ' + st.hip[i] ? 'HIP ' + st.hip[i] : '';
    var head = cardHead(name, sub);
    head.classList.add('voy-card__head--orb');
    cardEl.appendChild(head);
    var body = el('div', 'voy-card__body');

    /* a live spinning orb of this star, driven from the main rAF */
    var orbWrap = el('div', 'voy-orbwrap');
    var orbCv = previewCanvas('voy-orb', 120, 120);
    orbWrap.appendChild(orbCv);
    head.insertBefore(orbWrap, head.lastChild);
    previews.star = { cv: orbCv, g: prevCtx(orbCv), w: 120, h: 120, i: i };

    /* arrival summary (present only right after a cruise) */
    if (arriveInfo && arriveInfo.star === i) {
      var av = el('div', 'voy-arrive');
      av.appendChild(el('p', 'voy-arrive__line',
        'Arrived. On the ship: ' + PURE.fmtYears(arriveInfo.shipYears) +
        '. On Earth it is now ' + arriveInfo.earthYear + '.'));
      var arow = el('div', 'voy-actions');
      var rep = el('button', 'voy-btn', 'Replay');
      var repFrom = arriveInfo.from;
      rep.type = 'button';
      /* the ship lives at the destination now, so a replay has to put it
         back where the trip started before flying it again */
      rep.addEventListener('click', function () {
        if (repFrom) {
          shipAt = PURE.normShipAt(repFrom, PLANET_KEYS.length, NS);
          saveShipAt();
        }
        startStarCruise(i);
      });
      var back = el('button', 'voy-btn', 'Back');
      back.type = 'button';
      back.addEventListener('click', function () {
        arriveInfo = null;
        openCardFor({ kind: 's', idx: i });
      });
      arow.appendChild(rep); arow.appendChild(back);
      av.appendChild(arow);
      body.appendChild(av);
    }

    var T = starTempOf(i);
    var lumV = A.starLumV(st.absmag[i]);
    var lb = starBolLum(i);
    var radius = A.starRadiusSun(lb, T);
    var words = A.spectWords(st.sp[i], lumV);
    body.appendChild(el('p', 'voy-fact',
      words + (st.sp[i] ? ' (type ' + st.sp[i] + ')' : '') + '.'));
    body.appendChild(el('p', 'voy-fact',
      PURE.distPhrase(starLyD[i]) + ' away; ' +
      PURE.lightPhrase(starLyD[i], thisYearFrac) + '.'));
    /* no invented facts: a star with no measured/derived temperature (the
       pulsar, brown dwarfs) simply has no temperature or size line */
    if (isFinite(T)) {
      var tline = el('p', 'voy-fact');
      var rgb = A.kelvinToRgb(T);
      var sw = el('span', 'voy-swatch');
      sw.style.background = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
      tline.appendChild(sw);
      tline.appendChild(document.createTextNode(
        ' Surface about ' + PURE.fmtInt(Math.round(T / 100) * 100) + ' K.'));
      body.appendChild(tline);
    }
    var sz = isFinite(radius) ? PURE.sizeVsSun(radius) : null;
    if (sz) body.appendChild(el('p', 'voy-fact', 'Its width: ' + sz + '.'));
    var mw = PURE.magWords(st.mag[i]);
    if (mw) body.appendChild(el('p', 'voy-fact', 'From Earth it ' + mw + '.'));

    /* exoplanet chips */
    var list = starPlanets[i];
    if (list && list.length) {
      body.appendChild(el('p', 'voy-fact voy-fact--chips',
        list.length === 1 ? 'One known planet:' : list.length + ' known planets:'));
      var chips = el('div', 'voy-chips');
      var openers = [];
      for (var k = 0; k < list.length; k++) {
        (function (j) {
          var p = exoObj(j);
          var inHz = exoInHz(j, i);
          var chip = el('button', 'voy-chip');
          chip.type = 'button';
          chip.id = 'voy-chip-' + j;
          chip.setAttribute('aria-expanded', 'false');
          chip.appendChild(el('span', 'voy-chip__name', p.name));
          chip.appendChild(el('span', 'voy-chip__line', PURE.chipLine(p, inHz)));
          var det = el('div', 'voy-chipbody');
          det.hidden = true;
          /* the impression orb, with the honesty line it must always carry */
          var oW = el('div', 'voy-orbwrap voy-orbwrap--exo');
          var oCv = previewCanvas('voy-orb voy-orb--exo', 100, 100);
          oW.appendChild(oCv);
          det.appendChild(oW);
          var lines = PURE.chipDetail(p, inHz);
          for (var q = 0; q < lines.length; q++) det.appendChild(el('p', null, lines[q]));
          det.appendChild(el('p', 'voy-orbnote', EXO_IMPRESSION));
          function setOpen(open) {
            det.hidden = !open;
            chip.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
              selExo = j;
              previews.exo = { cv: oCv, g: prevCtx(oCv), w: 100, h: 100, j: j };
              /* frame it: ease the camera in so the orbit fills the view */
              var aa = SD.planets.a[j];
              if (aa == null || !isFinite(aa) || aa <= 0) {
                var pp2 = SD.planets.per[j];
                if (pp2 != null && isFinite(pp2) && pp2 > 0) aa = Math.pow(pp2 / 365.25, 2 / 3);
              }
              if (centeredStar === i && aa != null && isFinite(aa) && aa > 0) {
                camGo({ logD: Math.log(clampN(aa * 4, 0.1, 200)) / Math.LN10 }, 900);
              }
            } else if (selExo === j) {
              selExo = -1;
              previews.exo = null;
            }
          }
          chip.addEventListener('click', function () {
            var wasOpen = !det.hidden;
            for (var w2 = 0; w2 < openers.length; w2++) openers[w2](false);
            if (!wasOpen) setOpen(true);
          });
          openers.push(setOpen);
          chips.appendChild(chip);
          chips.appendChild(det);
          if (opts && opts.exo === j) setOpen(true);
        })(list[k]);
      }
      body.appendChild(chips);
      body.appendChild(el('p', 'voy-note',
        'Orbit sizes are real; positions on them are not.'));
    }

    var row = el('div', 'voy-actions');
    var plan = el('button', 'voy-btn voy-btn--primary', 'Plan the trip');
    plan.type = 'button';
    var zoom = el('button', 'voy-btn', 'Zoom to it');
    zoom.type = 'button';
    zoom.addEventListener('click', function () { flyToStar(i, false); });
    row.appendChild(plan); row.appendChild(zoom);
    body.appendChild(row);

    /* trip section, revealed by Plan the trip */
    var trip = buildTripSection(i);
    trip.hidden = true;
    body.appendChild(trip);
    plan.addEventListener('click', function () {
      trip.hidden = false;
      plan.disabled = true;
      updateTripLive(i);
      trip.scrollIntoView({ block: 'nearest' });
    });
    if (opts && opts.trip) {
      trip.hidden = false;
      plan.disabled = true;
      updateTripLive(i);
    }
    cardEl.appendChild(body);
  }

  var tripEls = null;                     /* live nodes of the open trip section */
  function buildTripSection(i) {
    var dLy = starLyD[i];
    var wrap = el('div', 'voy-trip');
    wrap.appendChild(el('p', 'voy-trip__title', 'Getting there'));
    var tbl = el('table', 'voy-trip__table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'how'));
    hr.appendChild(el('th', null, 'travel time'));
    hr.appendChild(el('th', null, 'notes'));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    var rows = A.coastTimes(dLy);
    for (var k = 0; k < rows.length; k++) {
      var tr = el('tr');
      tr.appendChild(el('td', null, rows[k].name));
      tr.appendChild(el('td', null, PURE.fmtYears(rows[k].years)));
      tr.appendChild(el('td', 'voy-trip__note', rows[k].note));
      tb.appendChild(tr);
    }
    var hlr = el('tr', 'voy-trip__row--hl');
    var hlName = el('td', null, 'Constant 1 g ship');
    var hlTime = el('td', null, '');
    hlr.appendChild(hlName);
    hlr.appendChild(hlTime);
    hlr.appendChild(el('td', 'voy-trip__note', 'accelerates halfway, flips, brakes; actually stops there'));
    tb.appendChild(hlr);
    tbl.appendChild(tb);
    wrap.appendChild(tbl);

    function seg(labels, cur, onPick, aria) {
      var g = el('div', 'voy-seg');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', aria);
      var btns = [];
      for (var q = 0; q < labels.length; q++) {
        (function (qi) {
          var b = el('button', 'voy-seg__btn' + (qi === cur ? ' voy-seg__btn--on' : ''), labels[qi]);
          b.type = 'button';
          b.setAttribute('aria-pressed', qi === cur ? 'true' : 'false');
          b.addEventListener('click', function () {
            for (var w = 0; w < btns.length; w++) {
              btns[w].classList.toggle('voy-seg__btn--on', w === qi);
              btns[w].setAttribute('aria-pressed', w === qi ? 'true' : 'false');
            }
            onPick(qi);
          });
          btns.push(b);
          g.appendChild(b);
        })(q);
      }
      return g;
    }
    wrap.appendChild(seg(['0.3 g', '1 g', '2 g'], accelIdx, function (q) {
      var was = shipKeyOf(accelIdx);
      accelIdx = q;
      setShipPreview(was);
      updateTripLive(i);
    }, 'Acceleration'));

    /* the rocket that would fly this acceleration */
    var prevWrap = el('div', 'voy-shipprev-wrap');
    var prevCv = previewCanvas('voy-shipprev', 210, 120);
    prevWrap.appendChild(prevCv);
    var shipName = el('p', 'voy-shipname', '');
    var shipLine = el('p', 'voy-shipline', '');
    prevWrap.appendChild(shipName);
    prevWrap.appendChild(shipLine);
    if (SHIPS) {
      wrap.appendChild(prevWrap);
      previews.ship = { cv: prevCv, g: prevCtx(prevCv), w: 210, h: 120,
                        key: shipKeyOf(accelIdx), prevKey: null, fadeT0: 0,
                        name: shipName, line: shipLine, host: wrap };
      setShipPreview(null);
    }

    /* non-breaking spaces keep the mass with its unit: at 390 px the plain
       string wrapped and left an orphaned "t" on its own line */
    wrap.appendChild(seg(['probe 1 t', 'crewed 1,000 t',
                          'generation 1,000,000 t'], shipIdx, function (q) {
      shipIdx = q; updateTripLive(i);
    }, 'Ship'));

    var peak = el('p', 'voy-live');
    var energy = el('p', 'voy-live');
    var photon = el('p', 'voy-live');
    wrap.appendChild(peak);
    wrap.appendChild(energy);
    wrap.appendChild(photon);
    wrap.appendChild(el('p', 'voy-warp',
      "The Alcubierre warp idea fits general relativity's equations but needs negative " +
      'energy nobody knows how to make, so it has no honest travel time.'));
    /* the ship lives somewhere: say where the numbers are measured from */
    var origin = el('p', 'voy-note', '');
    wrap.appendChild(origin);

    var launch = el('button', 'voy-btn voy-btn--primary', 'Launch');
    launch.type = 'button';
    launch.addEventListener('click', function () { startStarCruise(i); });
    wrap.appendChild(launch);
    tripEls = { name: hlName, time: hlTime, peak: peak, energy: energy,
                photon: photon, star: i, launch: launch, origin: origin };
    return wrap;
  }
  /* the ship preview swaps design with a short crossfade */
  function setShipPreview(oldKey) {
    var p = previews && previews.ship;
    if (!p) return;
    var key = shipKeyOf(accelIdx);
    if (oldKey && oldKey !== key) {
      p.prevKey = oldKey;
      p.fadeT0 = performance.now();
    }
    p.key = key;
    var spec = null, q;
    if (SHIP_LIST) {
      for (q = 0; q < SHIP_LIST.length; q++) if (SHIP_LIST[q].key === key) spec = SHIP_LIST[q];
    }
    if (p.name) p.name.textContent = spec ? spec.name : '';
    if (p.line) p.line.textContent = spec ? spec.line : '';
  }
  function updateTripLive(i) {
    if (!tripEls || tripEls.star !== i) return;
    var dLy = starLyD[i];
    var g = A.ACCEL_PRESETS[accelIdx];
    var b = A.brachistochrone(dLy, g);
    var en = A.voyageEnergy(dLy, g, A.SHIP_PRESETS[shipIdx].massKg);
    tripEls.name.textContent = 'Constant ' + g + ' g ship';
    tripEls.time.textContent = PURE.fmtYears(b.shipYears) + ' on the ship, ' +
      PURE.fmtYears(b.earthYears) + ' on Earth';
    tripEls.peak.textContent = 'Peak speed ' + PURE.fmtSpeedC(b.vPeakC) + 'c (γ = ' +
      PURE.fmtGamma(b.gammaPeak) + ').';
    tripEls.energy.textContent = 'Energy for the trip: ' + PURE.fmtJoules(en.joules) + ', ' +
      PURE.energyPhrase(en.worldYears) + '.';
    var fuel = PURE.fuelAmount(en.massRatio);
    tripEls.photon.textContent = fuel
      ? 'Even a perfect photon rocket would need about ' + fuel + ' kg of fuel for every kg that arrives.'
      : '';
    var here = shipAt.kind === 's' && shipAt.idx === i;
    if (tripEls.launch) {
      tripEls.launch.disabled = here;
      tripEls.launch.textContent = here ? 'You are already there' : 'Launch';
    }
    if (tripEls.origin) {
      tripEls.origin.textContent = here
        ? 'Your ship is already in orbit around ' + starName(i) + '.'
        : ('Your ship is in orbit around ' + shipLabel() + '.' +
           (shipAt.kind === 's'
             ? ' Distances and times here are measured from the solar system.'
             : ''));
    }
  }

  /* ==================================================================
     Star cruise v2: a seven-beat cinematic instead of a single tween.
     The ship starts wherever it is parked (shipAt), lights its engines,
     flips at the tau midpoint, brakes, and captures into orbit at the
     destination, where it STAYS. Phase timing lives in PURE.cruisePhaseAt
     so it is node-testable; everything here is drawing and camera work.
     ================================================================== */
  var orbPlanet = -1;                   /* force a planet orb (cruise close-ups) */

  /* ==================================================================
     D2: the camera rig.

     ONE basis and TWO projectors (CL-09). The SKY is projected with the eye
     exactly at the ship's world position, because the rig offset is about
     1e-9 AU against stars 1e5 AU away: carrying it in world coordinates
     would change no star's direction by more than 3e-14 rad and would
     quantize into about ten float64 ULPs at Sirius. The SHIP is projected
     in a local frame measured in ship-lengths, so it lands off-centre, it
     moves correctly under free look, and its drawn size is a clean function
     of the rig distance.
     ================================================================== */
  var RIG_BACK = 2.2, RIG_UP = 0.35, RIG_SIDE = 0.55;   /* ship-lengths */
  var RIG_LEN = PURE.RIG_LEN, SHIP_PX_K = PURE.SHIP_PX_K;
  var RIG_D_MIN = PURE.RIG_D_MIN, RIG_D_MAX = PURE.RIG_D_MAX;
  var DEPART_AU = PURE.DEPART_AU;
  /* how much the drawn hull is turned toward profile. The rig looks along
     the ship's own nose, so the true geometry is a near end-on view that
     drawShip renders as a disc; this eases it back toward the 3/4 the
     shipped chase seat used, continuously and with the right sign. */
  var SHIP_PROF_K = 0.42;
  /* how far the chase camera swings toward the body being left, at the
     start of the departure arc (radians of slerp weight, 0..1) */
  var DEP_FRAME = 0.18;
  /* ...and how far the ship may travel before it has escaped and the
     framing is done. It is the parking stand-off itself: past that the ship
     is level with the body it left, the direction to that body sweeps
     through a right angle in a frame or two, and a camera still trying to
     hold it in frame whips. */
  var DEP_HOLD_AU = PURE.DEPART_AU * 0.9;
  var DEP_TAU = 0.22;                   /* framing follower time constant, s */

  var rigD = 1;                         /* wheel / pinch, [0.6, 8] */
  var lookYaw = 0, lookPitch = 0;       /* persistent free-look offsets */
  var lookDrag = null;
  var camQ = null;                      /* spring-damped rig orientation */
  var camWx = 0, camWy = 0, camWz = 0;  /* its angular velocity, rad/s */
  var CAM_W0 = 16;                      /* spring rate, critically damped */
  var viewQ = [0, 0, 0, 1];             /* orientation the cruise draws with */
  var viewB = { fX: 0, fY: 0, fZ: 0, rX: 0, rY: 0, rZ: 0, uX: 0, uY: 0, uZ: 0 };
  var rigBasis = { fX: 0, fY: 0, fZ: 0, rX: 0, rY: 0, rZ: 0, uX: 0, uY: 0, uZ: 0 };
  var QA = [0, 0, 0, 1], QB = [0, 0, 0, 1], QC = [0, 0, 0, 1];
  var QD = [0, 0, 0, 1], QE = [0, 0, 0, 1], QF = [0, 0, 0, 1];
  var QS = [0, 0, 0, 1], QG = [0, 0, 0, 1];
  var QH = [0, 0, 0, 1], QI = [0, 0, 0, 1], QJ = [0, 0, 0, 1];
  var QIDENT = [0, 0, 0, 1];
  var depRel = [0, 0, 0, 1];            /* eased departure-framing offset */
  var VF = [0, 0, 0], VU = [0, 0, 0], VX = [0, 0, 0];

  function resetRig() {
    rigD = 1; lookYaw = 0; lookPitch = 0; lookDrag = null;
    camQ = null; camWx = 0; camWy = 0; camWz = 0;
    depRel[0] = 0; depRel[1] = 0; depRel[2] = 0; depRel[3] = 1;
    cam.basis = null;
  }

  /* Critically damped angular spring. The ship snaps through the flip; the
     camera lags a beat behind it and catches up, which is the whole reason
     the flip reads as motion instead of as a cut.

     Two things keep it honest on slow hardware. It SUBSTEPS, so the spring
     integrates the real elapsed time rather than a clamped slice: a tab
     throttled to 1 rAF per second used to leave the camera most of a
     half-turn behind and fling the ship thousands of pixels off screen.
     And the lag is hard-capped, so no frame rate and no user input can put
     the ship outside the frame. */
  /* The cap sits well ABOVE the lag the spring actually produces (about
     0.39 rad against the fastest turn in the timeline), so it is a stall
     backstop and not part of the normal follow: clamping inside the normal
     range turned into a per-frame correction that WAS the snap it was meant
     to prevent. */
  var CAM_LAG_MAX = 0.9;                /* radians */
  function springStep(target, dt) {
    QA[0] = -camQ[0]; QA[1] = -camQ[1]; QA[2] = -camQ[2]; QA[3] = camQ[3];
    var e = PURE.qMul(QA, target, QB);
    var ex = e[0], ey = e[1], ez = e[2], ew = e[3];
    if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; ew = -ew; }
    var s = Math.sqrt(ex * ex + ey * ey + ez * ez);
    var ang = 2 * Math.atan2(s, ew);
    var tx = 0, ty = 0, tz = 0;
    if (s > 1e-12) { tx = ex / s * ang; ty = ey / s * ang; tz = ez / s * ang; }
    var k = CAM_W0 * CAM_W0, c2 = 2 * CAM_W0;
    camWx += (k * tx - c2 * camWx) * dt;
    camWy += (k * ty - c2 * camWy) * dt;
    camWz += (k * tz - c2 * camWz) * dt;
    var ax = camWx * dt, ay = camWy * dt, az = camWz * dt;
    var an = Math.sqrt(ax * ax + ay * ay + az * az);
    if (an > 1e-12) {
      PURE.qAxisAngle(ax / an, ay / an, az / an, an, QC);
      PURE.qNormalize(PURE.qMul(camQ, QC, QS));
      camQ[0] = QS[0]; camQ[1] = QS[1]; camQ[2] = QS[2]; camQ[3] = QS[3];
    }
  }
  function springOrient(target, dt) {
    if (!camQ) {
      camQ = [target[0], target[1], target[2], target[3]];
      camWx = camWy = camWz = 0;
      return;
    }
    var d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0;
    if (d > 0.35) {                     /* a real stall: catch up, do not lag */
      camQ = [target[0], target[1], target[2], target[3]];
      camWx = camWy = camWz = 0;
      return;
    }
    var n = Math.ceil(d / 0.02), i;
    if (n > 0) { for (i = 0; i < n; i++) springStep(target, d / n); }
    if (!isFinite(camQ[0]) || !isFinite(camQ[3])) {
      camQ = [target[0], target[1], target[2], target[3]];
      camWx = camWy = camWz = 0;
      return;
    }
    var lag = PURE.qAngle(camQ, target);
    if (lag > CAM_LAG_MAX) {
      PURE.qSlerp(camQ, target, 1 - CAM_LAG_MAX / lag, QS);
      camQ[0] = QS[0]; camQ[1] = QS[1]; camQ[2] = QS[2]; camQ[3] = QS[3];
    }
  }

  function basisFromQ(q, out) {
    var F = PURE.qRot(q, 0, 0, 1, VF);
    var U = PURE.qRot(q, 0, 1, 0, VU);
    var X = PURE.qRot(q, 1, 0, 0, VX);
    out.fX = F[0]; out.fY = F[1]; out.fZ = F[2];
    out.uX = U[0]; out.uY = U[1]; out.uZ = U[2];
    out.rX = -X[0]; out.rY = -X[1]; out.rZ = -X[2];
    return out;
  }

  /* seeded camera shake. Six sines, fixed phases, amplitude normalised to
     1: nothing unseeded and no wall clock, so two runs shake identically. */
  var SHK_N = 6, shkA = null, shkF = null, shkP = null, shkNorm = 1;
  function ensureShake() {
    if (shkA) return;
    shkA = new Float32Array(SHK_N); shkF = new Float32Array(SHK_N); shkP = new Float32Array(SHK_N);
    var rnd = mulberry32(517731), tot = 0, i;
    for (i = 0; i < SHK_N; i++) {
      shkA[i] = 0.35 + rnd() * 0.65;
      shkF[i] = 6 + rnd() * 26;
      shkP[i] = rnd() * 6.2832;
      tot += shkA[i];
    }
    shkNorm = tot > 0 ? 1 / tot : 1;
  }
  function shakeAt(tSec, axis) {
    ensureShake();
    var v = 0, i;
    for (i = 0; i < SHK_N; i++) {
      v += shkA[i] * Math.sin(shkF[i] * tSec + shkP[i] + axis * 2.137);
    }
    return v * shkNorm;
  }

  /* the ship, in the local rig frame. All of it is dimensionless ratios of
     ship-lengths, so world AU never enters. */
  var RIG = { ok: false, x: 0, y: 0, px: 0, yaw: 0, sang: 0, bank: 0 };
  var RLP = { x: 0, y: 0, z: 0 };
  function rigLocal(rx, ry, rz, ppx, ppy, out) {
    var b = viewB;
    var zc = rx * b.fX + ry * b.fY + rz * b.fZ;
    if (!(zc > 1e-4)) return false;
    var s = fpxV / zc;
    out.x = ppx + (rx * b.rX + ry * b.rY + rz * b.rZ) * s;
    out.y = ppy - (rx * b.uX + ry * b.uY + rz * b.uZ) * s;
    out.z = zc;
    return isFinite(out.x) && isFinite(out.y);
  }
  var RA = { x: 0, y: 0, z: 0 }, RB = { x: 0, y: 0, z: 0 }, RC = { x: 0, y: 0, z: 0 };
  function softLimit(v, mid, half) {
    if (!isFinite(v) || !(half > 0)) return mid;
    var x = (v - mid) / half;
    /* tanh, written out: Math.tanh is ES6 and this file is ES5 throughout */
    var e2 = Math.exp(2 * clampN(x, -20, 20));
    return mid + half * ((e2 - 1) / (e2 + 1));
  }
  function rigProjectShip(pose, ppx, ppy) {
    RIG.ok = false;
    if (!pose) return false;
    var q = pose.shipQ;
    var F = PURE.qRot(q, 0, 0, 1, VF);
    var U = PURE.qRot(q, 0, 1, 0, VU);
    var X = PURE.qRot(q, 1, 0, 0, VX);
    var d = rigD;
    /* eye = ship - back*F + up*U + side*right, and the page's right is -X,
       so rel = ship - eye = +back*F - up*U + side*X */
    var bx = RIG_BACK * d * F[0] - RIG_UP * d * U[0] + RIG_SIDE * d * X[0];
    var by = RIG_BACK * d * F[1] - RIG_UP * d * U[1] + RIG_SIDE * d * X[1];
    var bz = RIG_BACK * d * F[2] - RIG_UP * d * U[2] + RIG_SIDE * d * X[2];
    if (!rigLocal(bx, by, bz, ppx, ppy, RA)) return false;
    if (!rigLocal(bx + 0.5 * F[0], by + 0.5 * F[1], bz + 0.5 * F[2], ppx, ppy, RB)) return false;
    if (!rigLocal(bx - 0.5 * F[0], by - 0.5 * F[1], bz - 0.5 * F[2], ppx, ppy, RC)) return false;
    var dxs = RB.x - RC.x, dys = RB.y - RC.y;
    var sang = (dxs * dxs + dys * dys > 1e-8) ? Math.atan2(dys, dxs) : 0;
    var b2 = viewB;
    var nr = F[0] * b2.rX + F[1] * b2.rY + F[2] * b2.rZ;
    var nu = F[0] * b2.uX + F[1] * b2.uY + F[2] * b2.uZ;
    var nf = F[0] * b2.fX + F[1] * b2.fY + F[2] * b2.fZ;
    var yw = Math.atan2(nf, Math.sqrt(nr * nr + nu * nu)) * SHIP_PROF_K;
    /* roll relative to the camera: where the ship's own up lands on screen */
    var bank = 0;
    if (rigLocal(bx + 0.5 * U[0], by + 0.5 * U[1], bz + 0.5 * U[2], ppx, ppy, RC)) {
      var ux2 = RC.x - RA.x, uy2 = RC.y - RA.y;
      if (ux2 * ux2 + uy2 * uy2 > 1e-8) {
        bank = Math.atan2(uy2, ux2) - sang + Math.PI / 2;
        while (bank > Math.PI) bank -= 2 * Math.PI;
        while (bank < -Math.PI) bank += 2 * Math.PI;
      }
    }
    /* Soft screen limiter. The local projection is the pinned one, but two
       things can push its result out of frame: a tall narrow phone, where
       the rig's side offset is measured against fpxV (which scales with the
       HEIGHT) while the screen is only 390 px wide, and the spring lag
       through the flip. tanh leaves the normal position within a pixel and
       saturates instead of ever letting the hull leave the viewport. */
    var pxD = clampN(fpxV * SHIP_PX_K / (RIG_LEN * d), 12, 900);
    RIG.x = softLimit(RA.x, W * 0.5, Math.max(20, W * 0.5 - pxD * 0.75));
    RIG.y = softLimit(RA.y, H * 0.5, Math.max(20, H * 0.5 - pxD * 0.5));
    RIG.px = pxD;
    RIG.yaw = yw; RIG.sang = sang; RIG.bank = bank;
    RIG.ok = isFinite(RIG.x) && isFinite(RIG.y) && isFinite(RIG.px);
    return RIG.ok;
  }

  function cruisePlanOf(c) {
    return { dLy: c.dLy, a: c.a, tauTotal: c.tauTotal,
             ox: c.ox, oy: c.oy, oz: c.oz,
             ux: c.ux, uy: c.uy, uz: c.uz, distAU: c.distAU,
             shipKey: shipKeyOf(accelIdx), star: c.star };
  }

  function startStarCruise(i) {
    var dLy = starLyD[i];
    if (!(dLy > 0)) return;
    if (shipAt.kind === 's' && shipAt.idx === i) {
      setStatus('You are already there.');
      return;
    }
    arriveInfo = null;
    var g = A.ACCEL_PRESETS[accelIdx];
    var a = g * A.A_LYYR2_PER_G;
    var tot = PURE.cruiseTotals(dLy, a);
    var o = shipBodyPos({ x: 0, y: 0, z: 0 });
    var dx = starX[i] - o.x, dy = starY[i] - o.y, dz = starZ[i] - o.z;
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dist > 0)) {
      dx = starX[i]; dy = starY[i]; dz = starZ[i];
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    }
    cruiseSt = {
      star: i, from: { kind: shipAt.kind, idx: shipAt.idx },
      dLy: dLy, a: a, g: g,
      tauTotal: tot.tauTotal, tTotal: tot.tTotal, tauHalf: tot.tauHalf,
      ox: o.x, oy: o.y, oz: o.z,
      ux: dx / dist, uy: dy / dist, uz: dz / dist, distAU: dist,
      t0: performance.now(), cp: null, ph: null, pose: null, tPrev: 0,
      sx: o.x, sy: o.y, sz: o.z, launch: null
    };
    closeCard();
    camAnim = null;
    camBefore = null;
    mode = 'cruise';
    flipCapT0 = 0;
    /* every flight starts at full detail and earns its own demotion: this
       step is scoped to the cruise and must never carry over as a permanent
       one (CL-27) */
    cruiseLod = 0; clN = 0; clHot = 0; clCool = 0;
    /* and the launch itself is not evidence: the first second pays for the
       departure orb, the ship's first lathe and whatever the driver still
       owes on a shader, exactly the transient budgetHold already ignores
       for the explore governor */
    clHold = GOV_HOLD_MS;
    resetCaptions();
    setStatus('Leaving ' + shipLabel() + ' for ' + starName(i) + '. Watch the two clocks.');
    if (reduced) { arriveStar(); return; }
    /* beat 1: fly to wherever the ship actually is */
    if (cruiseSt.from.kind === 'p') { centeredStar = -1; orbPlanet = cruiseSt.from.idx; }
    else { centeredStar = cruiseSt.from.idx; orbPlanet = -1; }
    /* CL-18 launch handoff: the departure arc starts from the pose the
       explore camera is actually in and eases into the rig over the same
       2400 ms the old camGo took, so there is no cut at the boundary. */
    resetRig();
    updateCamBasis();
    cruiseSt.launch = {
      ex: camPX, ey: camPY, ez: camPZ,
      q: PURE.qFromBasis(-rX, -rY, -rZ, uX, uY, uZ, fX, fY, fZ),
      logD: cam.logD, ppx: cam.ppx || W / 2, ppy: cam.ppy || H * 0.5
    };
  }
  /* CL-18/CL-19 arrival handoff. Explore mode has no roll, so the last rig
     pose is written back as the yaw/pitch/centre/zoom triple that
     reproduces it exactly, and only then is the basis released. Both the
     natural end and a mid-flight skip land on the capture pose: the ship
     stops one capture-orbit radius short of the star with its nose on it,
     which is precisely what camSnapshot needs to hand camGo. */
  function handoffRigToExplore(c) {
    var i = c.star;
    var ax = starX[i] - c.ux * PURE.ARRIVE_AU;
    var ay = starY[i] - c.uy * PURE.ARRIVE_AU;
    var az = starZ[i] - c.uz * PURE.ARRIVE_AU;
    var dx = ax - starX[i], dy = ay - starY[i], dz = az - starZ[i];
    var dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
    cam.basis = null;
    if (!(dd > 1e-9)) { cam.ppx = W / 2; cam.ppy = H * 0.5; return; }
    cam.cx = starX[i]; cam.cy = starY[i]; cam.cz = starZ[i];
    cam.logD = Math.log(dd) / Math.LN10;
    cam.yaw = Math.atan2(dy, dx);
    cam.pitch = clampN(Math.asin(clampN(dz / dd, -1, 1)), -1.45, 1.45);
    cam.ppx = W / 2; cam.ppy = H * 0.5;
    camAnim = null;
  }

  function arriveStar() {
    if (!cruiseSt) return;
    if (!reduced) handoffRigToExplore(cruiseSt);
    resetRig();
    var i = cruiseSt.star;
    arriveInfo = {
      star: i,
      from: { kind: cruiseSt.from.kind, idx: cruiseSt.from.idx },
      shipYears: cruiseSt.tauTotal,
      earthYears: cruiseSt.tTotal,
      earthYear: calYear(cruiseSt.tTotal)
    };
    cruiseSt = null;
    orbPlanet = -1;
    mode = 'explore';
    shipAt = { kind: 's', idx: i };
    saveShipAt();
    starPulse = performance.now();
    flyToStar(i, false);                /* settle into the close-up */
    openCardFor({ kind: 's', idx: i }, { trip: true });
    updateTargetLine();
    setStatus('Arrived at ' + starName(i) + '. On the ship: ' +
      PURE.fmtYears(arriveInfo.shipYears) + '. On Earth it is now ' + arriveInfo.earthYear +
      '. Your ship is in orbit around ' + starName(i) + '.');
  }
  /* Any tap or Esc skips the rest of the cinematic and lands the ship. */
  function skipStarCruise() {
    if (!cruiseSt) return;
    arriveStar();
  }
  /* A programmatic teardown (a search, a porkchop, another selection) leaves
     the ship where it was: shipAt only changes on arrival. */
  function cancelStarCruise(silent) {
    if (mode !== 'cruise' || !cruiseSt) { cruiseSt = null; resetRig(); return; }
    cruiseSt = null;
    orbPlanet = -1;
    mode = 'explore';
    /* programmatic teardown: the offsets go and the basis is released, but
       the ship stays where it was and the camera is handed to the caller */
    resetRig();
    resetCaptions();
    if (silent) return;                 /* a follow-up action takes over */
    var pp = explorePP();
    cam.ppx = pp.x; cam.ppy = pp.y;
    if (shipAt.kind === 'p') flyToPlanet(shipAt.idx, reduced);
    else flyToStar(shipAt.idx, reduced);
    setStatus('Launch cancelled. Your ship is still at ' + shipLabel() + '.');
  }

  /* ---- cruise stepping (called from the rAF loop) ----
     One continuous pose over the UNCHANGED timeline. The phase names are
     still the authority for labels and for the thrust / flip envelopes;
     they no longer cut the camera anywhere. */
  function cruiseStep(nowMs) {
    var c = cruiseSt;
    if (!c) return;
    var el = nowMs - c.t0;
    var dt = c.tPrev ? clampN((nowMs - c.tPrev) / 1000, 0, 0.05) : 0;
    /* The camera spring gets the REAL elapsed time, never this clamped
       slice. The pose it chases is sampled from the wall clock, so feeding
       the spring a capped dt made it fall a whole frame's worth of turn
       behind on any long frame and then dump that debt into the NEXT frame
       however short it was: measured 0.15 rad of basis rotation inside a
       9 ms frame right after an 84 ms one, an outsized step by any reading.
       springOrient already substeps at 20 ms and snaps past a 350 ms stall,
       so real time is safe to hand it. */
    var dtReal = c.tPrev ? clampN((nowMs - c.tPrev) / 1000, 0, 2) : 0;
    c.tPrev = nowMs;
    var ph = PURE.cruisePhaseAt(el, c.tauTotal);
    c.ph = ph;
    if (ph.done) { arriveStar(); return; }
    var pose = PURE.cruisePose(el / 1000, cruisePlanOf(c));
    c.pose = pose;
    var cp = PURE.cruisePoint(c.dLy, c.a, ph.tau);
    cp.tau = ph.tau;
    c.cp = cp;
    c.sx = pose.x; c.sy = pose.y; c.sz = pose.z;

    if (ph.phase === 'flip' && !flipCapT0) flipCapT0 = nowMs;

    /* which body owns the close-up orb; unchanged from the shipped beats */
    if (ph.phase === 'depart-zoom' || ph.phase === 'ignite') {
      if (c.from.kind === 'p') { centeredStar = -1; orbPlanet = c.from.idx; }
      else { centeredStar = c.from.idx; orbPlanet = -1; }
    } else if (ph.phase === 'capture') {
      orbPlanet = -1; centeredStar = c.star;
    } else {
      orbPlanet = -1; centeredStar = -1;
    }

    /* the free-look offsets ease back to zero across the capture arc, so
       explore inherits a view with no leftover angle (CL-18) */
    if (ph.phase === 'capture') {
      if (c.lookAtCap == null) { c.lookAtCap = [lookYaw, lookPitch]; }
      var dk = 1 - easeInOutCubic(clampN(ph.k / 0.85, 0, 1));
      lookYaw = c.lookAtCap[0] * dk;
      lookPitch = c.lookAtCap[1] * dk;
    } else if (c.lookAtCap != null) { c.lookAtCap = null; }

    /* orientation: spring-follow the ship, then the user's own look */
    springOrient(pose.shipQ, dtReal);
    PURE.qAxisAngle(0, 1, 0, lookYaw, QA);
    PURE.qAxisAngle(1, 0, 0, lookPitch, QB);
    /* the COCKPIT looks out of the nose, always */
    viewQ = PURE.qNormalize(PURE.qMul(PURE.qMul(camQ, QA, QC), QB, QG));
    basisFromQ(viewQ, rigBasis);
    /* the CHASE camera is a movie camera: while the ship is still on its
       parking orbit it holds the body being left in frame and eases back
       onto the nose as the ship escapes. Chase only, and orientation only:
       the aberration is keyed to the velocity and cannot see this (CL-23). */
    /* The weight also runs out as soon as the ship is level with the body
       it left: past that point the direction to that body sweeps through a
       right angle in a frame or two, and a camera still holding it in frame
       whipped the ship 287 px across the screen in ONE frame. */
    var frameW = DEP_FRAME * clampN(pose.depW, 0, 1) *
                 (1 - PURE.smooth01(pose.travel / DEP_HOLD_AU));
    /* The framing is carried as a RELATIVE offset on top of camQ and eased
       with an exponential follower. camQ's own motion (the spring whose lag
       is what makes the flip read as motion) passes through untouched, and
       the offset itself can then only ever appear or die at 1/DEP_TAU, so
       nothing the look-at target does can put a cut in the frame. */
    QH[0] = 0; QH[1] = 0; QH[2] = 0; QH[3] = 1;    /* target offset */
    if (frameW > 0.002) {
      var lx = c.ox - pose.x, ly = c.oy - pose.y, lz = c.oz - pose.z;
      var ln = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (ln > 1e-9) {
        lx /= ln; ly /= ln; lz /= ln;
        var cu = PURE.qRot(camQ, 0, 1, 0, VU);
        var dpu = cu[0] * lx + cu[1] * ly + cu[2] * lz;
        var qux = cu[0] - dpu * lx, quy = cu[1] - dpu * ly, quz = cu[2] - dpu * lz;
        var qun = Math.sqrt(qux * qux + quy * quy + quz * quz);
        if (qun > 1e-6) {
          qux /= qun; quy /= qun; quz /= qun;
          var qxx = quy * lz - quz * ly, qxy = quz * lx - qux * lz, qxz = qux * ly - quy * lx;
          PURE.qFromBasis(qxx, qxy, qxz, qux, quy, quz, lx, ly, lz, QD);
          /* camQ^-1 * QD, then that much of it */
          QE[0] = -camQ[0]; QE[1] = -camQ[1]; QE[2] = -camQ[2]; QE[3] = camQ[3];
          PURE.qMul(QE, QD, QI);
          PURE.qSlerp(QIDENT, QI, frameW, QH);
        }
      }
    }
    var fw = 1 - Math.exp(-(dtReal > 0 ? dtReal : 0) / DEP_TAU);
    PURE.qSlerp(depRel, QH, fw, QJ);
    depRel[0] = QJ[0]; depRel[1] = QJ[1]; depRel[2] = QJ[2]; depRel[3] = QJ[3];
    var chaseQ = camQ;
    if (Math.abs(depRel[3]) < 0.999999) {
      chaseQ = PURE.qNormalize(PURE.qMul(camQ, depRel, QE));
    }
    var chaseV = PURE.qNormalize(PURE.qMul(PURE.qMul(chaseQ, QA, QC), QB, QF));
    basisFromQ(chaseV, viewB);

    /* zoom: only ever the input to the LOD ramps and the orb radius law.
       While the ship is still near the body it left, it tracks the real
       distance so the departure orb is framed the way it always was. */
    var dox = pose.x - c.ox, doy = pose.y - c.oy, doz = pose.z - c.oz;
    var dOrig = Math.sqrt(dox * dox + doy * doy + doz * doz);
    var lgT = clampN(Math.log(Math.max(1.2, dOrig)) / Math.LN10, 0.08, 1.5);
    var ppxT = W * 0.58, ppyT = H * 0.44;
    if (ph.phase === 'capture') {
      var e = easeInOutCubic(clampN(ph.k, 0, 1));
      lgT = 1.5 + (0.75 - 1.5) * e;
      ppxT = W * 0.58 + (W / 2 - W * 0.58) * e;
      ppyT = H * 0.44 + (H * 0.5 - H * 0.44) * e;
    }

    var ex = pose.x, ey = pose.y, ez = pose.z;
    var lg = lgT, px2 = ppxT, py2 = ppyT;
    var L0 = c.launch;
    if (L0) {
      var w = easeInOutCubic(clampN(el / 2400, 0, 1));
      ex = L0.ex + (pose.x - L0.ex) * w;
      ey = L0.ey + (pose.y - L0.ey) * w;
      ez = L0.ez + (pose.z - L0.ez) * w;
      lg = L0.logD + (lgT - L0.logD) * w;
      px2 = L0.ppx + (ppxT - L0.ppx) * w;
      py2 = L0.ppy + (ppyT - L0.ppy) * w;
      /* into the CHASE orientation, which is what this basis carries once
         the blend is over. Blending into viewQ (the cockpit's, with no
         departure framing on it) meant the last blended frame and the first
         un-blended one disagreed by the whole framing offset, and the ship
         stepped 57 px sideways at el = 2400 ms exactly. */
      PURE.qSlerp(L0.q, chaseV, w, QH);
      basisFromQ(QH, viewB);
      if (w >= 1) c.launch = null;
    }

    camAnim = null;
    cam.cx = ex; cam.cy = ey; cam.cz = ez;
    cam.logD = lg;
    /* shake: seeded, thrust-scaled, never more than half a percent of the
       view height, and exactly zero at coast and under reduced motion */
    var amp = reduced ? 0 : H * 0.005 * clampN(pose.shake01, 0, 1);
    cam.ppx = px2 + (amp ? shakeAt(el / 1000, 0) * amp : 0);
    cam.ppy = py2 + (amp ? shakeAt(el / 1000, 1) * amp : 0);
    cam.basis = viewB;
    if (rigProjectShip(pose, cam.ppx, cam.ppy)) {
      c.shipFade = clampN((c.shipFade || 0) + dt / 0.6, 0, 1);
    } else {
      c.shipFade = 0;
    }
  }

  /* ---- cockpit: aberration + Doppler colour table ---- */
  var fpColors = null;                  /* 16 ci buckets x 9 Doppler buckets */
  var FP_DOP = 9;
  function fpColorTable() {
    if (fpColors) return fpColors;
    var out = [], b, d;
    for (b = 0; b < 16; b++) {
      var ci = -0.4 + (b + 0.5) * 0.15;
      var T0 = A.starTempFromCi(ci);
      for (d = 0; d < FP_DOP; d++) {
        var lg = -2 + (d + 0.5) * (4 / FP_DOP);
        var T = clampN(T0 * Math.pow(2, lg), 1000, 40000);
        var c = A.kelvinToRgb(T);
        out.push('rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
      }
    }
    fpColors = out;
    return out;
  }
  function fpDopBucket(delta) {
    if (!(delta > 0) || !isFinite(delta)) return 4;
    var lg = Math.log(delta) / Math.LN2;
    var q = Math.floor((lg + 2) / (4 / FP_DOP));
    return q < 0 ? 0 : (q >= FP_DOP ? FP_DOP - 1 : q);
  }

  /* deterministic dust motes: fixed directions, animated depth */
  var DUST_N = 60, dustA = null, dustP = null;
  function ensureDust() {
    if (dustA) return;
    dustA = new Float32Array(DUST_N);
    dustP = new Float32Array(DUST_N);
    var rnd = mulberry32(90210);
    for (var i = 0; i < DUST_N; i++) { dustA[i] = rnd() * 6.2832; dustP[i] = rnd(); }
  }

  /* The cockpit view basis IS the rig basis: the flip and the free look
     rotate the camera, never the physics (CL-23). The old swing sweep is
     gone because the flip now lives in the ship's own orientation, which is
     what lets the whole sky roll instead of yawing past you. */
  var FPB = { fx: 0, fy: 0, fz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0 };
  function fpBasis() {
    var b = rigBasis;
    FPB.fx = b.fX; FPB.fy = b.fY; FPB.fz = b.fZ;
    FPB.rx = b.rX; FPB.ry = b.rY; FPB.rz = b.rZ;
    FPB.ux = b.uX; FPB.uy = b.uY; FPB.uz = b.uZ;
    return isFinite(FPB.fx) && isFinite(FPB.ux) &&
           (FPB.fx !== 0 || FPB.fy !== 0 || FPB.fz !== 0);
  }

  /* project a WORLD point as an aberrated direction seen from the ship.
     The aberration itself is PURE.aberrateDir, which takes the velocity and
     nothing else: no view basis is an argument, so where the crew look can
     never move where the sky bunches up. */
  var FPP = { x: 0, y: 0, ok: false, cos: 0, delta: 1, zc: 0 };
  var FPD = { x: 0, y: 0, z: 0, cos: 0, delta: 1 };
  function fpProject(c, beta, wx, wy, wz, fpx, ppx, ppy) {
    FPP.ok = false; FPP.zc = 0; FPP.cos = 0; FPP.delta = 1;
    var dx = wx - c.sx, dy = wy - c.sy, dz = wz - c.sz;
    var n = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(n > 1e-9)) return false;
    PURE.aberrateDir(c.ux, c.uy, c.uz, dx, dy, dz, beta, FPD);
    var ax = FPD.x, ay = FPD.y, az = FPD.z, cth = FPD.cos;
    var zc = ax * FPB.fx + ay * FPB.fy + az * FPB.fz;
    /* recorded before the cull so a caller can count what fell behind the
       camera, not only what survived onto the screen */
    /* aberrateDir already computed the Doppler factor for this very cos;
       asking PURE.dopplerFactor for it a second time was 5% of the cockpit
       frame across 65,000 stars */
    FPP.zc = zc; FPP.cos = cth; FPP.delta = FPD.delta;
    if (!(zc > 0.02)) return false;
    var sx2 = ppx + (ax * FPB.rx + ay * FPB.ry + az * FPB.rz) / zc * fpx;
    var sy2 = ppy - (ax * FPB.ux + ay * FPB.uy + az * FPB.uz) / zc * fpx;
    if (!isFinite(sx2) || !isFinite(sy2)) return false;
    FPP.x = sx2; FPP.y = sy2;
    FPP.ok = true;
    return true;
  }

  /* test hooks. front/back = stars on screen that started ahead of / behind the
     ship; behind = stars that are behind the CAMERA (culled, invisible, and the
     ones that dim and redden as beta climbs); red = drawn stars whose Doppler
     factor is below 1, i.e. the dimmed half of the sky. */
  var fpFront = 0, fpBack = 0, fpBehind = 0, fpRed = 0;

  function drawCockpit(c, now) {
    var ph = c.ph, cp = c.cp;
    if (!ph || !cp) return;
    var beta = clampN(cp.v, 0, 0.9999999);
    if (!fpBasis()) return;
    var fpx = (H * 0.5) / FOV_T;
    var ppx = W / 2, ppy = H * 0.5;
    var tbl = fpColorTable();
    var m = 6, i, dlt, br, bd, ci, cb;
    fpFront = 0; fpBack = 0; fpBehind = 0; fpRed = 0;
    /* The aberration is written out inline in both sky loops below rather
       than called per star. It is the SAME arithmetic in the same order as
       PURE.aberrateDir + PURE.dopplerFactor (which stay the pinned public
       versions, used by the destination orb, the look-back and the test
       hook): what goes away is five function calls and a betaClamp per
       star across 65,000 stars, plus the Doppler factor that fpProject used
       to compute twice. Nothing here reads the view basis, so CL-23 is
       untouched: bv/gv come from the velocity alone. */
    var bv = beta > 0.9999999 ? 0.9999999 : (beta > 0 ? beta : 0);
    var gv = 1 / Math.sqrt(1 - bv * bv);
    var cux = c.ux, cuy = c.uy, cuz = c.uz;
    var csx = c.sx, csy = c.sy, csz = c.sz;
    var Bfx = FPB.fx, Bfy = FPB.fy, Bfz = FPB.fz;
    var Brx = FPB.rx, Bry = FPB.ry, Brz = FPB.rz;
    var Bux = FPB.ux, Buy = FPB.uy, Buz = FPB.uz;
    var dx, dy, dz, q2, nn2, cth, cth2, s1, s2, ox, oy, oz, zc, ss, den;
    /* background tier first: this is what makes the sky feel deep */
    if (BG) {
      var cut = BG.cuts[bgCutIdx()];
      var cols = isLight() ? BG.colL : BG.colD;
      var pos = BG.pos, starts = BG.starts;
      for (var b2 = 0; b2 < 12; b2++) {
        var nn = cut[b2];
        if (!nn) continue;
        var sk2 = bgStride(b2 % 3);
        var a2 = 0.55 * BG_A[b2 % 3] * strideAlpha(sk2);
        var sz2 = 1.2 * strideSize(sk2);
        ctx.fillStyle = cols[b2];
        ctx.globalAlpha = a2 > 1 ? 1 : a2;
        for (var k2 = 0, j2 = starts[b2] * 3; k2 < nn; k2 += sk2, j2 += sk2 * 3) {
          dx = pos[j2] - csx; dy = pos[j2 + 1] - csy; dz = pos[j2 + 2] - csz;
          q2 = dx * dx + dy * dy + dz * dz;
          if (!(q2 > 1e-18)) continue;
          nn2 = Math.sqrt(q2);
          dx /= nn2; dy /= nn2; dz /= nn2;
          cth = dx * cux + dy * cuy + dz * cuz;
          if (cth > 1) cth = 1; else if (cth < -1) cth = -1;
          if (bv === 0) cth2 = cth;
          else {
            den = 1 + bv * cth;
            if (!(den > 1e-12)) cth2 = -1;
            else { cth2 = (cth + bv) / den; if (cth2 > 1) cth2 = 1; else if (cth2 < -1) cth2 = -1; }
          }
          s1 = 1 - cth * cth; s1 = s1 > 0 ? Math.sqrt(s1) : 0;
          s2 = 1 - cth2 * cth2; s2 = s2 > 0 ? Math.sqrt(s2) : 0;
          if (s1 > 1e-9) {
            ox = cth2 * cux + s2 * ((dx - cth * cux) / s1);
            oy = cth2 * cuy + s2 * ((dy - cth * cuy) / s1);
            oz = cth2 * cuz + s2 * ((dz - cth * cuz) / s1);
          } else if (cth2 >= 0) { ox = cux; oy = cuy; oz = cuz; }
          else { ox = -cux; oy = -cuy; oz = -cuz; }
          zc = ox * Bfx + oy * Bfy + oz * Bfz;
          if (!(zc > 0.02)) continue;
          ss = fpx / zc;
          dx = ppx + (ox * Brx + oy * Bry + oz * Brz) * ss;
          if (dx < -m || dx > W + m) continue;
          dy = ppy - (ox * Bux + oy * Buy + oz * Buz) * ss;
          if (dy < -m || dy > H + m) continue;
          ctx.fillRect(dx, dy, sz2, sz2);
        }
      }
      ctx.globalAlpha = 1;
    }
    /* the interactive tier, Doppler-shifted */
    var st = SD ? SD.stars : null;
    if (st) {
      var mags = st.mag, cis = st.ci;
      /* NOT strided, at any LOD level: these 5,240 are the real, named,
         clickable stars, they are a twelfth of the background tier's cost,
         and they are what fpCounts reports. The cruise LOD takes its saving
         out of the 60,000 anonymous ones above. */
      for (i = 0; i < NS; i++) {
        dx = starX[i] - csx; dy = starY[i] - csy; dz = starZ[i] - csz;
        q2 = dx * dx + dy * dy + dz * dz;
        if (!(q2 > 1e-18)) { fpBehind++; continue; }
        nn2 = Math.sqrt(q2);
        dx /= nn2; dy /= nn2; dz /= nn2;
        cth = dx * cux + dy * cuy + dz * cuz;
        if (cth > 1) cth = 1; else if (cth < -1) cth = -1;
        if (bv === 0) cth2 = cth;
        else {
          den = 1 + bv * cth;
          if (!(den > 1e-12)) cth2 = -1;
          else { cth2 = (cth + bv) / den; if (cth2 > 1) cth2 = 1; else if (cth2 < -1) cth2 = -1; }
        }
        s1 = 1 - cth * cth; s1 = s1 > 0 ? Math.sqrt(s1) : 0;
        s2 = 1 - cth2 * cth2; s2 = s2 > 0 ? Math.sqrt(s2) : 0;
        if (s1 > 1e-9) {
          ox = cth2 * cux + s2 * ((dx - cth * cux) / s1);
          oy = cth2 * cuy + s2 * ((dy - cth * cuy) / s1);
          oz = cth2 * cuz + s2 * ((dz - cth * cuz) / s1);
        } else if (cth2 >= 0) { ox = cux; oy = cuy; oz = cuz; }
        else { ox = -cux; oy = -cuy; oz = -cuz; }
        zc = ox * Bfx + oy * Bfy + oz * Bfz;
        if (!(zc > 0.02)) { fpBehind++; continue; }
        den = gv * (1 - bv * cth);
        dlt = (den > 1e-9) ? 1 / den : 1;
        ss = fpx / zc;
        dx = ppx + (ox * Brx + oy * Bry + oz * Brz) * ss;
        dy = ppy - (ox * Bux + oy * Buy + oz * Buz) * ss;
        if (!isFinite(dx) || !isFinite(dy)) continue;
        if (dx < -m || dx > W + m || dy < -m || dy > H + m) continue;
        if (cth > 0) fpFront++; else fpBack++;
        if (dlt < 1) fpRed++;
        br = dlt * dlt * dlt;
        if (br > 4) br = 4;
        var al = clampN(0.35 * br * (mags[i] < 4 ? 1.6 : 1), 0.03, 1);
        /* Once the page is shedding detail, the stars sitting ON the alpha
           floor go too. At high beta the receding half of the sky is dimmed
           by delta cubed, so thousands of these are drawn every frame at 3%
           over black, which is nothing to look at and a fillRect each. The
           counters above are already taken, so fpCounts still describes the
           whole sky. */
        if (cruiseLod >= 2 && al <= 0.0301) continue;
        ci = PURE.bucketOf(cis[i]);
        bd = fpDopBucket(dlt);
        cb = tbl[ci * FP_DOP + bd];
        ctx.fillStyle = cb;
        ctx.globalAlpha = al;
        var sz = mags[i] < 1.5 ? 3 : (mags[i] < 4 ? 2.2 : 1.6);
        ctx.fillRect(dx - sz / 2, dy - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
    }
    /* the destination, growing from a point into a disc */
    var di = c.star;
    if (fpProject(c, beta, starX[di], starY[di], starZ[di], fpx, ppx, ppy)) {
      var remain = Math.max(1e-6, (1 - (c.dLy > 0 ? cp.x / c.dLy : 0)) * c.distAU);
      var rr = clampN(fpx * 0.8 / remain, 1.5, Math.min(H * 0.3, 220));
      var art = starArtOf(di);
      if (art && rr > 4) {
        ART.drawStar(ctx, FPP.x, FPP.y, rr, art, now / 1000, { quality: orbQuality() });
      } else {
        drawStarBlob(FPP.x, FPP.y, Math.max(2, rr), starTempOf(di), 1);
      }
    }
    /* the origin body, red-shifted and dimmed by the real Doppler factor */
    drawLookBack(c, now, true, beta, fpx, ppx, ppy);
    /* dust motes: NOT physics, they just sell the motion (the copy says so) */
    if (cruiseLod >= 3) return;          /* first thing dropped when frames slip */
    ensureDust();
    var sp = 0.25 + beta * 2.2;
    ctx.strokeStyle = textColor(0.5);
    ctx.lineWidth = 1;
    ctx.globalAlpha = clampN(0.15 + beta * 0.5, 0, 0.8);
    ctx.beginPath();
    var Rmax = Math.sqrt(W * W + H * H) * 0.6;
    for (i = 0; i < DUST_N; i++) {
      var f = (dustP[i] + (now / 1000) * sp) % 1;
      var r0 = 18 + f * f * Rmax;
      var r1 = r0 + 6 + f * 60 * (0.3 + beta);
      var ca = Math.cos(dustA[i]), sa2 = Math.sin(dustA[i]);
      var x0 = ppx + r0 * ca, y0 = ppy + r0 * sa2;
      var x1 = ppx + r1 * ca, y1 = ppy + r1 * sa2;
      if (!isFinite(x0) || !isFinite(y1)) continue;
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     D3: the look back.

     The origin body drawn from its OWN world position, so the half of the
     trip that used to show nothing has an anchor that visibly recedes. Both
     views draw it; only the cockpit draws it with physics (CL-21). The
     brightness follows the honest delta cubed with no floor, which means it
     WILL fade out: the eye's anchor past that point is a reticle, which is
     chrome and claims nothing (CL-22).
     ================================================================== */
  var LBW = { x: 0, y: 0, z: 0 };
  var LB = { on: false, x: 0, y: 0, r: 0, alpha: 0, sprite: 0, dLy: 0, name: '', faint: false };
  function originWorld(c, out) {
    var o = out || LBW;
    if (c.from.kind === 's') {
      o.x = starX[c.from.idx]; o.y = starY[c.from.idx]; o.z = starZ[c.from.idx];
    } else { o.x = 0; o.y = 0; o.z = 0; }
    return o;
  }
  function originArt(c) {
    if (c.from.kind === 's') return starArtOf(c.from.idx);
    return (ART && ART.SOL_PARAMS) ? ART.SOL_PARAMS : null;
  }
  function originName(c) {
    return c.from.kind === 's' ? starName(c.from.idx) : 'the Sun';
  }
  function originTemp(c) {
    return c.from.kind === 's' ? starTempOf(c.from.idx) : 5772;
  }
  /* the Sun is not in the catalog, so its receding sprite is sized from its
     real absolute magnitude at the real distance, exactly the way the
     catalog's own apparent magnitudes were derived */
  function solSprite(dLy) {
    var mag = 4.83 + 5 * (Math.log(Math.max(1e-9, dLy)) / Math.LN10 - 1);
    var band = PURE.bandOf(mag);
    var row = mag < 1.6 ? 3 : band;
    return { cx: PURE.bucketOf(0.656) * 32, cy: row * 32, a: BAND_A[band] };
  }

  /* cockpit === true routes the draw through fpProject and applies the real
     Doppler factor; chase stays rest-frame and geometric. */
  function drawLookBack(c, now, cockpit, beta, fpx, ppx, ppy) {
    LB.on = false;
    var pose = c.pose;
    if (!pose) return;
    /* skip while the ordinary paths already have it on screen */
    if (c.from.kind === 's' && centeredStar === c.from.idx) return;
    if (c.from.kind !== 's' && nearSol()) return;
    var O = originWorld(c, LBW);
    var dx = O.x - pose.x, dy = O.y - pose.y, dz = O.z - pose.z;
    var dAU = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dAU > 1)) return;
    var sx2, sy2, delta = 1;
    if (cockpit) {
      if (!fpProject(c, beta, O.x, O.y, O.z, fpx, ppx, ppy)) return;
      sx2 = FPP.x; sy2 = FPP.y; delta = FPP.delta;
    } else {
      if (!projectPt(O.x, O.y, O.z, PRJ)) return;
      sx2 = PRJ.x; sy2 = PRJ.y;
    }
    if (sx2 < -200 || sx2 > W + 200 || sy2 < -200 || sy2 > H + 200) return;
    var rr = clampN(fpxV * 0.9 / dAU, 0, Math.min(H * 0.32, 240));
    var blend = PURE.orbBlend(rr);
    /* honest delta cubed, no floor: this is the same law the star field uses */
    var dim = clampN(delta * delta * delta, 0, 4);
    var dLy = dAU / LY_AU;
    var orbA = clampN(blend * dim, 0, 1);
    if (orbA > 0.004) {
      var art = originArt(c);
      if (art) {
        orbDrawStar(ctx, sx2, sy2, rr, art, orbT(now),
                    { quality: orbQuality(), alpha: orbA }, true);
      } else {
        drawStarBlob(sx2, sy2, rr, originTemp(c), orbA);
      }
    }
    var sprA = 0;
    if (c.from.kind !== 's') {
      var sp = solSprite(dLy);
      sprA = clampN((1 - blend) * sp.a * dim, 0, 1);
      if (sprA > 0.004) {
        var at2 = ensureAtlas();
        ctx.globalAlpha = sprA;
        ctx.drawImage(at2, sp.cx, sp.cy, 32, 32, sx2 - 8, sy2 - 8, 16, 16);
        ctx.globalAlpha = 1;
      }
    }
    LB.on = true; LB.x = sx2; LB.y = sy2; LB.r = rr;
    /* CL-22 keys the marker off the ORB's alpha, not off whatever sprite is
       standing in for it: in chase the origin is a rest-frame star that
       never dims, and the label is the whole point of the look back. */
    LB.alpha = orbA; LB.sprite = sprA;
    LB.dLy = dLy; LB.name = originName(c);
    LB.faint = orbA < 0.08;
    if (LB.faint) {
      /* the marker. A reticle is chrome, so it carries no honesty claim and
         needs none: the caption already says the light itself is gone. */
      ctx.strokeStyle = textColor(0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx2, sy2, 7, 0, 6.2832);
      ctx.moveTo(sx2 - 12, sy2); ctx.lineTo(sx2 - 9, sy2);
      ctx.moveTo(sx2 + 9, sy2); ctx.lineTo(sx2 + 12, sy2);
      ctx.moveTo(sx2, sy2 - 12); ctx.lineTo(sx2, sy2 - 9);
      ctx.moveTo(sx2, sy2 + 9); ctx.lineTo(sx2, sy2 + 12);
      ctx.stroke();
    }
  }

  function drawChase(c, now) {
    var ph = c.ph, cp = c.cp, pose = c.pose;
    if (!ph || !cp || !pose) return;
    var i = c.star;
    var fpx0 = (H * 0.5) / FOV_T;
    /* the route, from the ship's origin to the destination */
    if (projectSeg(c.ox, c.oy, c.oz, starX[i], starY[i], starZ[i])) {
      ctx.strokeStyle = gold();
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(SEGA.x, SEGA.y); ctx.lineTo(SEGB.x, SEGB.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    /* The destination star, bright regardless of the star-field fade. The
       same orbBlend the close-up uses drives it, so the disc grows out of
       the sprite instead of replacing it at a hard 4 px threshold. */
    if (projectPt(starX[i], starY[i], starZ[i], PRJ)) {
      var remain = Math.max(1e-6, (1 - (c.dLy > 0 ? cp.x / c.dLy : 0)) * c.distAU);
      var rr = clampN(fpx0 * 0.8 / remain, 0, Math.min(H * 0.3, 200));
      var db = PURE.orbBlend(rr);
      if (db < 1) {
        var at = ensureAtlas();
        ctx.globalAlpha = 1 - db;
        ctx.drawImage(at, starCellX[i], starCellY[i], 32, 32, PRJ.x - 12, PRJ.y - 12, 24, 24);
        ctx.globalAlpha = 1;
      }
      if (db > 0) {
        var art = starArtOf(i);
        if (art) {
          orbDrawStar(ctx, PRJ.x, PRJ.y, rr, art, orbT(now),
                      { quality: orbQuality(), alpha: db }, true);
        } else {
          drawStarBlob(PRJ.x, PRJ.y, rr, starTempOf(i), db);
        }
      }
    }
    /* the origin body, receding. Geometric only in this view: the chase sky
       is rest-frame, so nothing here may claim a colour (CL-21). */
    drawLookBack(c, now, false, 0, fpx0, cam.ppx, cam.ppy);
    /* one soft ring pulse as the ship settles into its capture orbit */
    if (ph.phase === 'capture' && ph.k > 0.55 &&
        projectPt(starX[i], starY[i], starZ[i], PRJ)) {
      var kp2 = clampN((ph.k - 0.55) / 0.45, 0, 1);
      ctx.strokeStyle = gold();
      ctx.globalAlpha = 0.6 * (1 - kp2);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(PRJ.x, PRJ.y, 12 + kp2 * 60, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    /* the ship, through the local rig projector. There is no phase branch
       left here: one projector for the whole cinematic is what removed the
       two position cuts the beats used to have. */
    if (!SHIPS || !RIG.ok) return;
    var fade = clampN(c.shipFade == null ? 1 : c.shipFade, 0, 1);
    if (!(fade > 0.004)) return;
    var ld = cruiseLightDir(c, pose);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(RIG.x, RIG.y);
    ctx.rotate(RIG.sang);
    SHIPS.drawShip(ctx, 0, 0, RIG.px, RIG.yaw, {
      key: shipKeyOf(accelIdx), thrust: pose.thrust01, t: now / 1000,
      /* the hull's procedural detail passes are the second heaviest thing
         in the frame; from cruise LOD 2 the ship drops to its cheap tier
         with the rest of the scene */
      quality: cruiseLod >= 2 ? 0 : orbQuality(), flip: 0, light: isLight(),
      bank: RIG.bank, lightDir: ld - RIG.sang
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* CL-25: the light on the hull comes from the body it is nearest to, as a
     SCREEN angle. Origin star for the first half, destination for the second. */
  function cruiseLightDir(c, pose) {
    var wx, wy, wz;
    if (pose.s01 < 0.5) { var O = originWorld(c, LBW); wx = O.x; wy = O.y; wz = O.z; }
    else { wx = starX[c.star]; wy = starY[c.star]; wz = starZ[c.star]; }
    if (!projectPt(wx, wy, wz, PRJ)) return Math.PI;
    var a = Math.atan2(PRJ.y - RIG.y, PRJ.x - RIG.x);
    return isFinite(a) ? a : Math.PI;
  }

  function cruiseHudLines(c) {
    var cp = c.cp, ph = c.ph;
    if (!cp || !ph) return null;
    var shipY = Math.round(cp.tau * 10) / 10;
    var earthY = Math.round(cp.t * 10) / 10;
    var cal = calYear(cp.t);
    var l1 = 'Ship clock ' + shipY + ' years · Earth clock ' + earthY +
             ' years passed · Earth calendar ' + cal;
    var speed = PURE.fmtSpeedC(cp.v) + 'c · γ ' + PURE.fmtGamma(cp.g);
    var state, stateShort;
    if (ph.phase === 'accel') {
      var left = Math.round(Math.max(0, c.tauHalf - cp.tau) * 10) / 10;
      state = 'flip in ' + left + ' ship-years';
      stateShort = 'flip in ' + left + ' yr';
    } else if (ph.phase === 'flip') { state = stateShort = 'turning around'; }
    else if (ph.phase === 'decel') { state = stateShort = 'braking'; }
    else if (ph.phase === 'capture') { state = stateShort = 'capturing into orbit'; }
    else if (ph.phase === 'ignite') { state = stateShort = 'engines lighting'; }
    else { state = stateShort = 'engines cold'; }
    /* Narrow screens get progressively shorter forms of the same numbers; the
       drawer measures and picks. Nothing is invented, only abbreviated, and the
       calendar year moves to line 2 rather than being dropped. */
    return {
      l1: l1, l2: speed + ' · ' + state, cal: cal,
      alt1: [l1,
             'Ship ' + shipY + ' yr · Earth ' + earthY + ' yr passed · ' + cal,
             'Ship ' + shipY + ' yr · Earth ' + earthY + ' yr passed'],
      alt2: [speed + ' · ' + state, speed + ' · ' + stateShort],
      alt2y: [speed + ' · ' + state + ' · Earth calendar ' + cal,
              speed + ' · ' + stateShort + ' · ' + cal,
              speed + ' · ' + cal]
    };
  }

  /* Draw one centred line, shrinking through the supplied shorter forms and
     then through the font size until it fits the canvas. Returns the index of
     the form that was used. */
  var hudDrawn = [];                      /* test hook: what the HUD actually drew */
  /* cx is optional and defaults to the screen centre, which is what every
     caller before the look-back reticle wanted. Wherever it is asked for,
     the box is clamped into [8, W-8] so the 390 px HUD bar still holds. */
  /* Text metrics are pure for a (font, string) pair and the HUD asks for
     the same handful of strings every frame, sometimes at half a dozen
     candidate lengths and then again as it steps the size down. Measuring
     them live cost about 1.5 ms of every cruise frame. The cache is capped
     and dropped whole, so a long session cannot grow it without bound. */
  var tmCache = {}, tmN = 0;
  function textW(f, s) {
    var k = f + ' ' + s;
    var v = tmCache[k];
    if (v !== undefined) return v;
    ctx.font = f;                        /* only ever on a miss */
    v = ctx.measureText(s).width;
    if (tmN > 600) { tmCache = {}; tmN = 0; }
    tmCache[k] = v; tmN++;
    return v;
  }
  function hudLine(cands, weight, basePx, minPx, maxW, y, color, cx) {
    var px = basePx, used = cands.length - 1, i;
    var font = weight + px + 'px ' + FONT;
    for (i = 0; i < cands.length; i++) {
      if (textW(font, cands[i]) <= maxW) { used = i; break; }
    }
    var txt = cands[used];
    var w = textW(font, txt);
    while (px > minPx && w > maxW) {
      px = Math.max(minPx, px - 0.5);
      font = weight + px + 'px ' + FONT;
      w = textW(font, txt);
    }
    ctx.font = font;
    var x = (typeof cx === 'number' && isFinite(cx)) ? cx : W / 2;
    var half = w / 2;
    if (x - half < 8) x = 8 + half;
    if (x + half > W - 8) x = W - 8 - half;
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
    hudDrawn.push({ txt: txt, px: px, w: w, y: y, x0: x - half, x1: x + half });
    return used;
  }

  /* ==================================================================
     D3: ONE caption track.

     There used to be three of these: a flip caption at a fixed y, a
     one-shot relativity note behind its own boolean, and nothing at all
     explaining the rest. This is the single queue that absorbed them, with
     one priority order (flip > timed > look-back), one persistence key, one
     measured y band, and one accessible mirror that lives OUTSIDE the
     collapsible panel where a live region actually announces.
     ================================================================== */
  var CAP_KEY = 'voy-fp-seen';
  var capTrack = PURE.cockpitCaptions();
  var capNext = 0;                      /* next timed entry to fire */
  var capCur = null;                    /* {text, alt, two, t0, ms, prio} */
  var capSeen = false;
  var capReplay = 0;                    /* replay clock offset, ms */
  var capSrLast = '';
  var elCapSr = id('voy-cap-sr');
  (function loadCapSeen() {
    try {
      if (window.sessionStorage && sessionStorage.getItem(CAP_KEY) === '1') capSeen = true;
    } catch (e9) { /* private mode: the track just plays again */ }
  })();
  function markCapSeen() {
    capSeen = true;
    try { if (window.sessionStorage) sessionStorage.setItem(CAP_KEY, '1'); } catch (eA) {}
  }
  function resetCaptions() {
    capNext = 0; capCur = null; capReplay = 0;
    if (elCapSr && capSrLast) { elCapSr.textContent = ''; capSrLast = ''; }
  }
  function replayCaptions() {
    capNext = 0; capCur = null;
    capReplay = cruiseSt ? (performance.now() - cruiseSt.t0) : 0;
    capSeen = false;
    setStatus('Replaying what happens on the way.');
  }
  function capShow(entry, prio, now) {
    if (capCur && capCur.prio < prio) return;      /* lower priority is dropped */
    capCur = { text: entry.text, alt: entry.alt || [entry.text], two: entry.two || null,
               t0: now, ms: entry.ms || 3200, prio: prio };
    if (elCapSr && entry.text !== capSrLast) {
      elCapSr.textContent = entry.text;
      capSrLast = entry.text;
    }
  }
  /* the band: under the HUD block and under the live FP bar, or low on the
     screen when that would push it past the bottom (CL-24) */
  function capBandY() {
    var hudBottom = 0, i;
    for (i = 0; i < hudDrawn.length; i++) {
      if (hudDrawn[i].y > hudBottom) hudBottom = hudDrawn[i].y;
    }
    var barB = 0;
    if (elFpBar && !elFpBar.hidden && elFpBar.getBoundingClientRect) {
      var r = elFpBar.getBoundingClientRect();
      if (r && r.height > 0) barB = r.bottom;
    }
    var y = Math.max(hudBottom, barB) + 18;
    return (y > H - 96) ? H * 0.78 : y;
  }
  function drawCaption(now, maxW) {
    if (!capCur) return;
    var t = now - capCur.t0;
    var a = clampN(t / 350, 0, 1) * (1 - ramp(t, capCur.ms - 400, capCur.ms));
    if (t > capCur.ms) { capCur = null; return; }
    if (!(a > 0.01)) return;
    var y = capBandY();
    var big = capCur.prio === 1;
    var col = textColor((big ? 0.92 : 0.85) * a);
    if (capCur.two) {
      ctx.font = '15px ' + FONT;
      if (ctx.measureText(capCur.text).width > maxW) {
        hudLine([capCur.two[0]], '', 15, 10, maxW, y, col);
        hudLine([capCur.two[1]], '', 15, 10, maxW, y + 20, col);
        return;
      }
    }
    hudLine(capCur.alt, big ? '600 ' : '', big ? 19 : 15, big ? 12 : 10, maxW, y, col);
  }

  function drawCruise(now) {
    var c = cruiseSt;
    if (!c || !c.cp || !c.ph) return;
    if (fpMode && !reduced) drawCockpit(c, now);
    else drawChase(c, now);

    /* HUD, kept clear of the transparent masthead. Every line is measured and
       compacted so nothing runs off a 320 px phone. */
    var hudY = Math.max(130, H * 0.16);
    var maxW = W - 16;
    hudDrawn = [];
    var lines = cruiseHudLines(c);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (lines) {
      var used = hudLine(lines.alt1, '600 ', 15, 10, maxW, hudY, textColor(0.92));
      /* the shortest first line drops the calendar year, so line 2 takes it */
      hudLine(used >= 2 ? lines.alt2y : lines.alt2, '', 13, 9.5, maxW,
              hudY + 21, textColor(0.75));
    }
    /* CL-40, verbatim: nothing on screen used to say free look existed */
    hudLine([coarsePointer ? 'Drag to look around. Tap to skip.'
                           : 'Drag to look around. Esc or tap to skip.'], '', 12, 9.5,
            maxW, hudY + 42, textColor(0.5));

    /* ---- the queue ---- */
    var el = now - c.t0;
    if (c.ph.phase === 'flip' && flipCapT0 && !c.flipCapDone) {
      c.flipCapDone = true;
      capShow({ text: 'Halfway. Turn around, burn the other way.',
                alt: ['Halfway. Turn around, burn the other way.',
                      'Halfway. Turn around and burn.'],
                ms: 2600 }, 1, now);
    }
    if (!capSeen || capReplay) {
      var clock = el - capReplay;
      while (capNext < capTrack.length && clock >= capTrack[capNext].t) {
        var ent = capTrack[capNext];
        capNext++;
        /* the relativity note is a cockpit claim; the rest are for both views */
        if (ent.two && !fpMode) continue;
        capShow(ent, 2, now);
      }
      if (capNext >= capTrack.length && !capReplay) markCapSeen();
    }
    /* the look-back caption: lowest priority, and it says nothing about
       colour unless the cockpit is actually drawing the colour (CL-21) */
    if (LB.on && LB.dLy > 0.002) {
      if (!c.lbCap) {
        c.lbCap = true;
        capShow({ text: fpMode
                    ? 'Looking back: the light behind you is stretched red and dim.'
                    : 'Looking back: the star you left is already a long way behind.',
                  alt: fpMode
                    ? ['Looking back: the light behind you is stretched red and dim.',
                       'The light behind you is stretched red and dim.']
                    : ['Looking back: the star you left is already a long way behind.',
                       'The star you left is a long way behind.'],
                  ms: 3600 }, 3, now);
      }
    }
    drawCaption(now, maxW);
    /* the receding origin's marker label, once its light is effectively gone */
    if (LB.on && LB.faint) {
      var d1 = LB.dLy;
      var dTxt = d1 >= 0.01 ? (Math.round(d1 * 100) / 100) + ' ly behind'
                            : (Math.round(d1 * LY_AU) + ' AU behind');
      ctx.font = '12px ' + FONT;
      hudLine([LB.name + ', ' + dTxt, LB.name], '', 12, 9.5, W - 16,
              clampN(LB.y + 22, 24, H - 12), textColor(0.55), LB.x);
    }
    ctx.textAlign = 'left';
  }

  /* ---------------- intro ---------------- */
  function startIntro() {
    mode = 'intro';
    introSt = { t0: performance.now() };
    cam.yaw = -0.9; cam.pitch = 0.35;
    cam.logD = Math.log(15) / Math.LN10;
    cam.cx = 0; cam.cy = 0; cam.cz = 0;
    var pp = explorePP();
    cam.ppx = pp.x; cam.ppy = pp.y;
    tagStart = null; tagKill = null;
  }
  function endIntro() {
    if (mode !== 'intro') return;
    mode = 'explore';
    introSt = null;
    viewJD = jdToday;   /* the intro tick is purely visual; explore shows TODAY */
    if (tagStart != null && tagKill == null) tagKill = performance.now();
  }
  function skipIntroTo(logD) {
    mode = 'explore';
    introSt = null;
    viewJD = jdToday;
    attract = false;
    tagStart = null;
    cam.yaw = -0.9; cam.pitch = 0.35;
    cam.logD = logD;
    cam.cx = 0; cam.cy = 0; cam.cz = 0;
    var pp = explorePP();
    cam.ppx = pp.x; cam.ppy = pp.y;
  }
  function introStep(now) {
    if (!introSt) return;
    /* re-paced 2026-07: the old 7.2 s intro lingered so long on the solar
       system that most visitors never saw the pull-out. */
    var t = now - introSt.t0;
    if (t < 400) {
      /* hold: planets tick along their real orbits */
    } else if (t < 4400) {
      var k = easeInOutCubic((t - 400) / 4000);
      cam.logD = 1.176 + (6.3 - 1.176) * k;
      if (t >= 2200 && tagStart == null) tagStart = now;
    } else {
      cam.logD = 6.3;
      endIntro();
    }
  }
  function drawTagline(now) {
    if (tagStart == null) return;
    var t = now - tagStart;
    var a = Math.min(1, t / 600) * (1 - ramp(t, 3000, 3600));
    if (tagKill != null) a *= 1 - clampN((now - tagKill) / 400, 0, 1);
    if (a <= 0.01) {
      if (t > 3600 || tagKill != null) { tagStart = null; tagKill = null; }
      return;
    }
    ctx.font = '26px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor(0.92 * a);
    ctx.fillText('Where do you want to go?', W / 2, H * 0.42);
    ctx.textAlign = 'left';
  }

  /* ---------------- drawing ---------------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* the open card's rect in canvas coordinates, or null */
  function rectOfCard() {
    if (!cardEl || cardEl.hidden || !cardEl.getBoundingClientRect) return null;
    var r = cardEl.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /* A caption that has to survive whatever is behind it. The exoplanet honesty
     line lands on the host star's own disc as often as not, so it gets a plate
     in the sky colour first: that sentence must be readable on any background. */
  function captionPlate(lines, cx0, y0, fontPx) {
    if (!lines || !lines.length || !isFinite(cx0) || !isFinite(y0)) return;
    var fs = fontPx || 11;
    var pAlign = ctx.textAlign, pBase = ctx.textBaseline;
    ctx.font = fs + 'px ' + FONT;
    var lh = Math.round(fs * 1.25), i, w = 0, mw;
    for (i = 0; i < lines.length; i++) {
      mw = ctx.measureText(lines[i]).width;
      if (mw > w) w = mw;
    }
    var padX = 9, padY = 6;
    var bw = Math.min(w + padX * 2, Math.max(40, W - 8));
    var bh = lines.length * lh + padY * 2;
    var bx = clampN(cx0 - bw / 2, 4, Math.max(4, W - bw - 4));
    var by = clampN(y0, 4, Math.max(4, H - bh - 6));
    /* slide clear of the open card rather than hiding half the sentence
       behind it, but only when the free strip is genuinely wide enough */
    var cr = cardOpen() ? rectOfCard() : null;
    if (cr && by + bh > cr.y && by < cr.y + cr.h && bx < cr.x + cr.w && bx + bw > cr.x) {
      if (W - (cr.x + cr.w) - 10 >= bw) bx = cr.x + cr.w + 6;
      else if (cr.x - 10 >= bw) bx = cr.x - bw - 6;
      else by = clampN(cr.y - bh - 8, 4, Math.max(4, H - bh - 6));
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = isLight() ? 'rgba(255,255,255,0.86)' : 'rgba(10,12,16,0.78)';
    roundRect(bx, by, bw, bh, 7);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isLight() ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isLight() ? 'rgba(38,38,38,0.94)' : 'rgba(222,222,222,0.94)';
    for (i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + bw / 2, by + padY + i * lh + (lh - fs) * 0.5);
    }
    ctx.textAlign = pAlign; ctx.textBaseline = pBase;
  }

  var galStride = 1;                     /* 2 = decimate if a frame budget slips */
  var galKey = '';                       /* last drawn camera/size signature */

  /* ---- the painted layers (voyage-galaxy.js) ----
     They are world-anchored in the galactic plane and projected through this
     page's OWN projector, so the painting swings with the star field instead
     of sitting behind it like wallpaper. The point cloud is drawn on top of
     them and carries every frame on its own while the bake is still running,
     which is also what happens if the file 404s. */
  var GAL_SEED = 20260727;               /* the same seed the cloud is built with */
  var galBakeTried = false;
  var galBasisCache = null;
  var galCam = { px: 0, py: 0, pz: 0, fX: 0, fY: 0, fZ: 0, rX: 0, rY: 0, rZ: 0,
                 uX: 0, uY: 0, uZ: 0, fpx: 0, ppx: 0, ppy: 0, D: 0 };
  var galOpts = { theme: 'dark', basis: null, mesh: 10, lyAu: LY_AU,
                  layers: { core: true, arms: true, halo: true }, W: 0, H: 0 };

  function galBasisOf() {
    if (!galBasisCache) galBasisCache = PURE.galBasis();
    return galBasisCache;
  }
  function startGalaxyBake() {
    var G = GAL();
    if (!G || typeof G.bake !== 'function') return;
    try {
      G.bake(GAL_SEED, { theme: effectiveTheme(), lyAu: LY_AU }, function () {
        /* a finished bake is a one-off cost; do not let it demote the scene */
        budgetHold = Math.max(budgetHold, GOV_HOLD_MS);
      });
    } catch (e) { /* the painting is an enhancement, never a requirement */ }
  }
  function drawGalaxyPaint(ga) {
    var G = GAL();
    if (!G || typeof G.draw !== 'function') return false;
    var b = galBasisOf();
    if (!b) return false;
    galCam.px = camPX; galCam.py = camPY; galCam.pz = camPZ;
    galCam.fX = fX; galCam.fY = fY; galCam.fZ = fZ;
    galCam.rX = rX; galCam.rY = rY; galCam.rZ = rZ;
    galCam.uX = uX; galCam.uY = uY; galCam.uZ = uZ;
    galCam.fpx = fpxV; galCam.ppx = cam.ppx; galCam.ppy = cam.ppy;
    galCam.D = camD;
    galOpts.theme = effectiveTheme();
    galOpts.basis = b;
    /* the LOD ladder of D7: halo first, then the arms, then the mesh */
    galOpts.mesh = galLod >= 1 ? 10 : 5;
    galOpts.layers.core = true;
    galOpts.layers.arms = galLod >= 1;
    galOpts.layers.halo = galLod >= 2;
    galOpts.W = W; galOpts.H = H;
    var painted = false;
    try { painted = !!G.draw(ctx, projectPt, galCam, ga, galOpts); }
    catch (e) { painted = false; }
    /* whatever the painting did to the context, the cloud below needs it back */
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return painted;
  }

  /* One path per tint bucket beats one fillRect per point by about 5x in a
     software rasteriser (measured: 22,600 points, 79 ms of fillRect against
     15 ms of batched rects at 4x CPU throttle). While the camera is actually
     MOVING the cloud is decimated as well, and it snaps back to every point
     on the first settled frame. */
  function drawGalaxy(ga) {
    var cl = buildGalaxy();
    var O = { x: 0, y: 0, z: 0 };
    if (!projectPt(0, 0, 0, O)) return;
    drawGalaxyPaint(ga);
    var xs = cl.x, ys = cl.y, zs = cl.z;
    var pal = isLight() ? GAL_TINT_L : GAL_TINT_D;
    var m = 8, b, i, px, py, pz, zc, s, sx2, sy2;
    var key = cam.yaw + '|' + cam.pitch + '|' + cam.logD + '|' + cam.cx + '|' +
              cam.cy + '|' + cam.cz + '|' + cam.ppx + '|' + cam.ppy + '|' + W + '|' + H;
    var moving = key !== galKey;
    galKey = key;
    /* The painted layers carry the low-frequency light now, so the moving
       decimation only needs to be 2x. The compensation is retuned to keep
       the total emitted light flat across the motion boundary: alpha x
       size^2 x count is boost * 1.15^2 / stride, and 0.512 puts that at
       1.000 for stride 2 (the old 0.42 with 3x landed at 0.81, a visible
       step every time a drag stopped). */
    var stride = galStride * (moving ? 2 : 1);
    var boost = stride > 1 ? Math.min(2.4, 1 + (stride - 1) * 0.512) : 1;
    for (b = 0; b < 3; b++) {
      var a = GAL_ALPHA[b] * ga * boost;
      if (!(a > 0.003)) continue;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.fillStyle = pal[b];
      var sz = GAL_SIZE[b] * (stride > 1 ? 1.15 : 1), half = sz / 2;
      var i0 = cl.start[b], i1 = cl.end[b];
      ctx.beginPath();
      for (i = i0; i < i1; i += stride) {
        px = xs[i] - camPX; py = ys[i] - camPY; pz = zs[i] - camPZ;
        zc = px * fX + py * fY + pz * fZ;
        if (zc <= nearD) continue;
        s = fpxV / zc;
        /* the third term is new (CL-08): the cruise rig can roll the camera,
           so rZ is no longer always zero. It costs one multiply-add per
           point and is bit-identical whenever rZ === 0. */
        sx2 = cam.ppx + (px * rX + py * rY + pz * rZ) * s;
        if (sx2 < -m || sx2 > W + m) continue;
        sy2 = cam.ppy - (px * uX + py * uY + pz * uZ) * s;
        if (sy2 < -m || sy2 > H + m) continue;
        ctx.rect(sx2 - half, sy2 - half, sz, sz);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    /* "you are here": accent ring exactly on the solar system's projection */
    ctx.strokeStyle = accent();
    ctx.globalAlpha = 0.9 * ga;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(O.x, O.y, 6, 0, 6.2832); ctx.stroke();
    ctx.font = '12px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = accent();
    var ly2 = Math.max(130, O.y);
    ctx.fillText('you are here', O.x + 12, ly2);
    ctx.globalAlpha = 1;
    /* the honest caption */
    if (ga > 0.4) {
      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = textColor(0.6 * ga);
      ctx.fillText('The galaxy here is an illustration, roughly to scale. Every clickable star is real.',
        W / 2, H - 44);
      ctx.textAlign = 'left';
    }
  }

  /* ==================================================================
     Background star tier (~60,000 more REAL stars, drawn not clickable).
     assets/js/voyage-bg.js is injected after the first painted frame and is
     PURELY an enhancement: every path here null-guards, and a 404 leaves the
     page exactly as it was.
     ================================================================== */
  var BG = null;                         /* decoded tier or null */
  var bgTried = false;
  var BG_LOD = [15000, 35000, 60000];
  var bgLod = 2;                         /* index into BG_LOD; never climbs back */

  function bgUrl() {
    var tags = document.getElementsByTagName('script'), i, src;
    for (i = 0; i < tags.length; i++) {
      src = tags[i].getAttribute('src') || '';
      if (src.indexOf('voyage-data.js') >= 0) return src.replace('voyage-data.js', 'voyage-bg.js');
    }
    return null;
  }
  function bgBuild(raw) {
    var d = PURE.bgDecode(raw, LY_AU);
    if (!d) return;
    var n = d.n, i, b;
    /* 12 buckets, each keeping the file's brightest-first order so an LOD
       cut is a prefix of every bucket list */
    var counts = new Uint32Array(12);
    var bk = new Uint8Array(n);
    for (i = 0; i < n; i++) { b = PURE.bgBucket(d.ci[i], d.mag[i]); bk[i] = b; counts[b]++; }
    var cursor = new Uint32Array(12), starts = new Uint32Array(12);
    for (b = 1; b < 12; b++) starts[b] = starts[b - 1] + counts[b - 1];
    /* cuts[l][b] = how many of bucket b fall inside LOD level l */
    var cuts = [new Uint32Array(12), new Uint32Array(12), new Uint32Array(12)];
    /* Positions are copied into ONE interleaved array in bucket order, so
       both sky loops read straight through memory instead of chasing an
       index list into three separate 480 KB coordinate arrays. Same points,
       same order, same pixels: this is only about the cache. It is worth
       about 3 ms a frame of the cruise, which is the frame's single
       biggest line item. */
    var pos = new Float64Array(n * 3);
    for (i = 0; i < n; i++) {
      b = bk[i];
      var o3 = (starts[b] + cursor[b]) * 3;
      cursor[b]++;
      pos[o3] = d.x[i]; pos[o3 + 1] = d.y[i]; pos[o3 + 2] = d.z[i];
      for (var l = 0; l < 3; l++) if (i < BG_LOD[l]) cuts[l][b]++;
    }
    /* colors: 4 ci groups through the same Ballesteros + blackbody path the
       interactive tier uses, so the two tiers agree */
    var CI_MID = [0.0, 0.4, 0.85, 1.5];
    var colD = [], colL = [];
    for (b = 0; b < 12; b++) {
      var c = A.kelvinToRgb(A.starTempFromCi(CI_MID[(b / 3) | 0]));
      colD.push('rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
      colL.push('rgb(' + Math.round(c.r * 0.42) + ',' + Math.round(c.g * 0.42) + ',' +
                Math.round(c.b * 0.46) + ')');
    }
    BG = { n: n, pos: pos, starts: starts, cuts: cuts,
           colD: colD, colL: colL };
  }
  function loadBgTier() {
    if (bgTried) return;
    bgTried = true;
    if (window.VOYAGE_BG) { try { bgBuild(window.VOYAGE_BG); } catch (eb) { BG = null; } return; }
    var url = bgUrl();
    if (!url) return;
    var s = document.createElement('script');
    s.defer = true;
    s.src = url;
    s.onload = function () {
      try { if (window.VOYAGE_BG) bgBuild(window.VOYAGE_BG); } catch (eb2) { BG = null; }
    };
    s.onerror = function () { BG = null; };
    (document.head || document.documentElement).appendChild(s);
  }

  /* ==================================================================
     The cruise LOD step.

     CL-27 gives the cruise its own budget and forbids it from demoting the
     explore view, because the cruise is the heaviest scene in the session
     BY DESIGN: it is the only one that draws both star tiers, the ship and
     the HUD in the same frame (explore fades the tiers out at every zoom a
     close-up or the galaxy is drawn at). This is that own step: a stride
     over each brightness group of both tiers, brightest group last and
     least, with the per-star alpha and size raised to keep the sky's
     weight, plus the ship's cheap detail tier from level 2.

     It is measured from the cruise's OWN frames, it is scoped to the
     flight (reset at every launch), and it recovers. On hardware that
     holds its frame budget it never leaves level 0, so what a visitor sees
     is exactly what was there before; it engages when frames actually
     slip, which is the only honest way to hold a 4x-throttled 33 ms bar
     against a scene this heavy.
     ================================================================== */
  var cruiseLod = 0;                     /* 0 = full scene, 3 = cheapest */
  /* The background tier is stored brightest first, which is what makes its
     LOD cuts a prefix, so the cruise step spends the prefix FIRST (the
     faintest thousands are what a strided sky loses anyway, and dropping
     them keeps the remaining ones at full density instead of thinning the
     bright ones) and only then strides inside each brightness group. */
  var CL_CUT = [-1, 1, 0, 0];            /* -1 = whatever bgLod already says */
  var CL_BG = [[1, 1, 1], [1, 1, 1], [1, 1, 2], [1, 2, 4]];
  var CL_STAR = [[1, 1, 1], [1, 1, 2], [1, 2, 4], [2, 4, 8]];
  var clBuf = new Float32Array(12), clN = 0, clHot = 0, clCool = 0, clHold = 0;
  /* Two thresholds, because one number cannot be both "never touch a scene
     that is doing fine" and "keep cutting until the frame is actually good".
     Evidence above CL_MID counts at its own length and evidence above CL_HI
     counts five times over, so a frame rate that has collapsed outright
     (CL_HI is about 18 fps on a vsync-locked browser, where a dropped frame
     reads as a whole extra 16.7 ms) sheds detail in a third of a second,
     while a scene merely sitting under 33 fps has to stay there for a second
     and a half before anything is touched. Leaving level 0 needs three times
     the evidence of every step after it: once the page has admitted it is
     struggling it keeps cutting until the frame is inside the budget.
     Recovery is one step per 4 s of frames back on the 60 Hz grid, and the
     gap between CL_LO and CL_MID is what stops it hunting. */
  var CL_HI = 55;                        /* ms: collapsed, act at once */
  var CL_MID = 30;                       /* ms: over budget, act on patience */
  var CL_LO = 20;                        /* ms, sustained: recover a step */

  function skyLod() { return mode === 'cruise' ? cruiseLod : 0; }
  /* stride for brightness group g (0 = brightest) */
  function bgStride(g) { return CL_BG[skyLod()][g]; }
  function starStride(b) { return CL_STAR[skyLod()][b]; }
  function bgCutIdx() {
    var l = skyLod();
    if (!l) return bgLod;
    var c = CL_CUT[l];
    return (c < 0 || c > bgLod) ? bgLod : c;
  }
  function strideAlpha(sk) { return sk > 1 ? Math.sqrt(sk) : 1; }
  function strideSize(sk) { return sk > 1 ? 1 + (sk - 1) * 0.05 : 1; }

  function clMedian() {
    var a = [], i;
    for (i = 0; i < 12; i++) a.push(clBuf[i]);
    a.sort(function (p, q) { return p - q; });
    return (a[5] + a[6]) / 2;
  }
  function cruiseBudget(dtMs) {
    if (mode !== 'cruise') { clN = 0; clHot = 0; clCool = 0; clHold = 0; return; }
    if (!(dtMs > 0) || dtMs > 600) return;
    if (clHold > 0) { clHold -= dtMs; return; }
    clBuf[clN % 12] = dtMs;
    clN++;
    if (clN < 12) return;
    var med = clMedian();
    if (med > CL_MID) { clHot += (med > CL_HI ? dtMs * 5 : dtMs); clCool = 0; }
    else { clHot = 0; if (med < CL_LO) clCool += dtMs; else clCool = 0; }
    if (clHot >= (cruiseLod === 0 ? 1500 : 500) && cruiseLod < 3) {
      cruiseLod += (cruiseLod >= 1 && med > CL_MID * 2) ? 2 : 1;
      if (cruiseLod > 3) cruiseLod = 3;
      clHot = 0; clCool = 0; clHold = 250;
    } else if (clCool >= 4000 && cruiseLod > 0) {
      cruiseLod--;
      clHot = 0; clCool = 0; clHold = 250;
    }
  }

  /* alpha per brightness group, dimmest last */
  var BG_A = [0.85, 0.6, 0.4];
  function drawBgTier(sa) {
    if (!BG) return;
    var light = isLight();
    var cols = light ? BG.colL : BG.colD;
    var cut = BG.cuts[bgCutIdx()];
    var pos = BG.pos, starts = BG.starts;
    var m = 4, b, k, nn, j, px, py, pz, zc, s, sx2, sy2;
    var ppx = cam.ppx, ppy = cam.ppy;
    for (b = 0; b < 12; b++) {
      nn = cut[b];
      if (!nn) continue;
      var sk = bgStride(b % 3);
      var a = sa * BG_A[b % 3] * strideAlpha(sk);
      if (!(a > 0.004)) continue;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.fillStyle = cols[b];
      var sz = ((b % 3) === 0 ? 1.6 : 1.1) * strideSize(sk);
      j = starts[b] * 3;
      for (k = 0; k < nn; k += sk, j += sk * 3) {
        px = pos[j] - camPX; py = pos[j + 1] - camPY; pz = pos[j + 2] - camPZ;
        zc = px * fX + py * fY + pz * fZ;
        if (zc <= nearD) continue;
        s = fpxV / zc;
        sx2 = ppx + (px * rX + py * rY + pz * rZ) * s;   /* CL-08 third term */
        if (sx2 < -m || sx2 > W + m) continue;
        sy2 = ppy - (px * uX + py * uY + pz * uZ) * s;
        if (sy2 < -m || sy2 > H + m) continue;
        ctx.fillRect(sx2, sy2, sz, sz);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* Rolling frame budget: drop one LOD tier (and decimate the galaxy) when
     the median rAF delta stays above 24 ms for about a second. The two point
     tiers never climb back inside the session, so they cannot oscillate.

     What IS new (D7): the governor ignores the cruise entirely and holds off
     for 1500 ms after a mode change or a finished galaxy bake. The cruise is
     the heaviest scene in the session BY DESIGN, and a one-off spike there
     used to permanently demote the explore view you come back to. The
     painted galaxy layers get their own step, galLod, which is the one
     demotion that is allowed to recover. */
  var fdBuf = new Float32Array(30), fdN = 0, fdOver = 0;
  var fdSort = new Float32Array(30);
  var galLod = 2;                        /* 2 all layers / 1 core+arms / 0 core, mesh 5 */
  var galGood = 0;                       /* ms of comfortable frames while demoted */
  var GOV_HOLD_MS = 1500;
  var budgetHold = 0;                    /* ms of samples still being ignored */

  function fdMedian() {
    var i, j, v;
    for (i = 0; i < 30; i++) fdSort[i] = fdBuf[i];
    for (i = 1; i < 30; i++) {           /* 30 items: insertion sort is the fast one */
      v = fdSort[i];
      for (j = i - 1; j >= 0 && fdSort[j] > v; j--) fdSort[j + 1] = fdSort[j];
      fdSort[j + 1] = v;
    }
    return (fdSort[14] + fdSort[15]) / 2;
  }

  function frameBudget(dtMs) {
    if (!(dtMs > 0) || dtMs > 400) return;
    if (mode === 'cruise') return;
    if (budgetHold > 0) { budgetHold -= dtMs; return; }
    fdBuf[fdN % 30] = dtMs;
    fdN++;
    if (fdN < 30) return;
    var i, over = 0;
    for (i = 0; i < 30; i++) if (fdBuf[i] > 24) over++;
    if (over > 15) fdOver++; else fdOver = 0;
    if (fdOver >= 30) {
      fdOver = 0;
      galGood = 0;
      if (galLod > 0) galLod--;
      if (bgLod > 0) bgLod--;
      else if (galStride < 2) galStride = 2;
    }
    /* recovery, painted layers only: one step back per 6 s of comfortable
       frames, and the counter restarts after each one, so it can climb at
       most one step every 6 s and never faster than the scene earns it. */
    if (galLod < 2) {
      if (fdMedian() < 18) galGood += dtMs; else galGood = 0;
      if (galGood >= 6000) { galGood = 0; galLod++; }
    }
  }

  function drawStars(sa) {
    var at = ensureAtlas();
    var b, k, i, n;
    var m = 16;                          /* offscreen margin */
    for (b = 0; b < 3; b++) {
      var list = bandLists[b];
      n = list.length;
      var sk = starStride(b);
      var a = sa * BAND_A[b] * strideAlpha(sk);
      ctx.globalAlpha = a > 1 ? 1 : a;
      for (k = 0; k < n; k += sk) {
        i = list[k];
        var px = starX[i] - camPX, py = starY[i] - camPY, pz = starZ[i] - camPZ;
        var zc = px * fX + py * fY + pz * fZ;
        if (zc <= nearD) { scrOk[i] = 0; continue; }
        var s = fpxV / zc;
        var sx2 = cam.ppx + (px * rX + py * rY + pz * rZ) * s;   /* CL-08 third term */
        var sy2 = cam.ppy - (px * uX + py * uY + pz * uZ) * s;
        if (sx2 < -m || sx2 > W + m || sy2 < -m || sy2 > H + m) { scrOk[i] = 0; continue; }
        scrX[i] = sx2; scrY[i] = sy2; scrOk[i] = 1;
        ctx.drawImage(at, starCellX[i], starCellY[i], 32, 32, sx2 - 8, sy2 - 8, 16, 16);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSun(D) {
    var P = PRJ;
    if (!projectPt(0, 0, 0, P)) return null;
    var size = clampN(fpxV * 0.00465 / D, 2, 26);
    var glow = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, size * 5);
    if (isLight()) {
      glow.addColorStop(0, 'rgba(160,124,44,0.5)'); glow.addColorStop(1, 'rgba(160,124,44,0)');
    } else {
      glow.addColorStop(0, 'rgba(245,238,216,0.5)'); glow.addColorStop(1, 'rgba(245,238,216,0)');
    }
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(P.x, P.y, size * 5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = isLight() ? 'rgba(160,124,44,0.9)' : 'rgba(245,238,216,0.95)';
    ctx.beginPath(); ctx.arc(P.x, P.y, size, 0, 6.2832); ctx.fill();
    return { x: P.x, y: P.y };
  }

  /* Is the camera still looking at our own system? Beyond about 0.05 light
     years the Sun and its planets are a sub-pixel cluster and drawing them
     only produces a stray "Mercury" tag in the corner of a star close-up. */
  var HOME_AU = 0.05 * LY_AU;
  function nearSol() {
    var d2 = cam.cx * cam.cx + cam.cy * cam.cy + cam.cz * cam.cz;
    return !(d2 > HOME_AU * HOME_AU);
  }

  var planetScr = [];                     /* per-frame planet screens */
  var planetOrbPx = 0, planetOrbIdx = -1; /* last drawn solar-planet orb */
  (function () { for (var i = 0; i < 8; i++) planetScr.push({ ok: false, x: 0, y: 0 }); })();

  function drawPolyline(flat, alpha, color, lw) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw || 1;
    ctx.beginPath();
    var open = false;
    var P = PRJ;
    for (var k = 0; k < flat.length; k += 3) {
      if (projectPt(flat[k], flat[k + 1], flat[k + 2], P)) {
        if (!open) { ctx.moveTo(P.x, P.y); open = true; }
        else ctx.lineTo(P.x, P.y);
      } else open = false;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSolar(pa, now) {
    var i;
    var labels = [];
    var inPork = mode === 'porkchop';
    for (i = 0; i < 8; i++) {
      var key = PLANET_KEYS[i];
      drawPolyline(orbitOf(key), 0.35 * pa, 'rgba(127,127,127,0.9)', 1);
    }
    /* ghost transfer arc + markers (porkchop) */
    if (inPork && ghost) {
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.5 * pa;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var open = false, P = PRJ;
      for (var k2 = 0; k2 < ghost.pts.length; k2++) {
        var gp = ghost.pts[k2];
        if (projectPt(gp[0], gp[1], gp[2], P)) {
          if (!open) { ctx.moveTo(P.x, P.y); open = true; } else ctx.lineTo(P.x, P.y);
        } else open = false;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (projectPt(ghost.rDep[0], ghost.rDep[1], ghost.rDep[2], P)) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = accent();
        ctx.beginPath(); ctx.arc(P.x, P.y, 4.5, 0, 6.2832); ctx.stroke();
      }
      if (projectPt(ghost.rArr[0], ghost.rArr[1], ghost.rArr[2], P)) {
        ctx.strokeStyle = gold();
        ctx.beginPath(); ctx.arc(P.x, P.y, 4.5, 0, 6.2832); ctx.stroke();
      }
    }
    /* planets at viewJD */
    var selPlanet = (sel && sel.kind === 'p') ? sel.idx : -1;
    planetOrbPx = 0; planetOrbIdx = -1;
    var sunScr = { ok: false, x: 0, y: 0 };
    sunScr.ok = projectPt(0, 0, 0, PRJ);
    if (sunScr.ok) { sunScr.x = PRJ.x; sunScr.y = PRJ.y; }
    for (i = 0; i < 8; i++) {
      var st = A.planetState(PLANET_KEYS[i], viewJD);
      var P2 = planetScr[i];
      P2.ok = projectPt(st.r[0], st.r[1], st.r[2], PRJ);
      if (!P2.ok) continue;
      P2.x = PRJ.x; P2.y = PRJ.y;
      var isTgt = inPork && PLANET_KEYS[i] === pcTarget;
      var color = (i === 2) ? accent() : (isTgt || selPlanet === i ? gold() : 'rgba(127,127,127,0.95)');
      /* the selected world gets a real orb once the camera is close enough;
         the tiny orbit-view discs are left alone */
      var wantOrb = ART && !inPork && camD < 60 &&
                    (selPlanet === i || orbPlanet === i) &&
                    isFinite(P2.x) && isFinite(P2.y);
      if (wantOrb) {
        var opx = clampN(PLANET_R[i] * 2.2 * (60 / Math.max(0.5, camD)),
                         PLANET_R[i] + 2, Math.min(H * 0.34, 240));
        var lds = Math.PI;
        if (sunScr.ok) {
          var la = Math.atan2(sunScr.y - P2.y, sunScr.x - P2.x);
          if (isFinite(la)) lds = la;
        }
        ctx.globalAlpha = 1;
        orbBacking(P2.x, P2.y, opx, pa);
        orbDrawPlanet(ctx, P2.x, P2.y, opx, solArtOf(i), orbT(now),
                      { quality: orbQuality(), lightDir: lds, alpha: pa }, true);
        planetOrbPx = opx; planetOrbIdx = i;
        /* the ring is a "this one" marker for a dot; on a big orb it is just
           a circle drawn through the middle of a world */
        if (opx <= ORB_SEL_MAX) {
          ctx.strokeStyle = gold();
          ctx.globalAlpha = clampN(0.6 * pa, 0, 1);
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(P2.x, P2.y, opx + 6, 0, 6.2832); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.globalAlpha = pa;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(P2.x, P2.y, PLANET_R[i], 0, 6.2832); ctx.fill();
        if (selPlanet === i && !inPork) {
          ctx.strokeStyle = gold();
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(P2.x, P2.y, PLANET_R[i] + 4, 0, 6.2832); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      /* the parked ship, drawn at whichever planet it is orbiting */
      if (mode !== 'cruise' && shipAt.kind === 'p' && shipAt.idx === i && camD < 60) {
        drawParkedShip(P2.x, P2.y, wantOrb ? planetOrbPx : PLANET_R[i], now, pa);
      }
      var wantLabel = camD < 60 || (inPork && (i === 2 || isTgt));
      if (wantLabel) {
        labels.push({ i: i, x: P2.x, y: P2.y, txt: PLANET_LABELS[i],
                      color: i === 2 ? accent() : (isTgt || selPlanet === i ? gold() : null) });
      }
    }
    /* A close-up orb owns its patch of screen. "Venus" and "Mars" landing on
       Earth's disc read as labels FOR that disc, and past ORB_SEL_MAX the orb
       is plainly the thing being looked at, so its own tag goes too (the card
       and the panel both name it). */
    if (planetOrbIdx >= 0 && planetOrbPx > 24) {
      var ob = planetScr[planetOrbIdx], keep = [];
      for (i = 0; i < labels.length; i++) {
        var lo = labels[i];
        if (ob.ok && Math.hypot(lo.x - ob.x, lo.y - ob.y) < planetOrbPx + 14 &&
            (lo.i !== planetOrbIdx || planetOrbPx > ORB_SEL_MAX)) continue;
        if (lo.i === planetOrbIdx) lo.r = planetOrbPx;   /* park it under the orb */
        keep.push(lo);
      }
      labels = keep;
    }
    /* greedy label placement: skip a label that collides with a placed one */
    ctx.font = '10.5px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var placed = [];
    for (i = 0; i < labels.length; i++) {
      var lb = labels[i];
      var lpad = lb.r || 0;
      var ly3 = lb.y < H * 0.17 ? lb.y + 12 + lpad : lb.y - 9 - lpad;
      var wpx = ctx.measureText(lb.txt).width;
      var rect = { x: lb.x + 8, y: ly3 - 7, w: wpx, h: 14 };
      var hit = false;
      for (var q = 0; q < placed.length; q++) {
        var o = placed[q];
        if (rect.x < o.x + o.w && rect.x + rect.w > o.x && rect.y < o.y + o.h && rect.y + rect.h > o.y) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(rect);
      ctx.globalAlpha = 0.55 * pa + (lb.color ? 0.3 : 0);
      ctx.fillStyle = lb.color || textColor(0.8);
      ctx.fillText(lb.txt, lb.x + 8, ly3);
      ctx.globalAlpha = 1;
    }

    /* porkchop cruise ship + trail. The trajectory is the v1 Lambert arc,
       unchanged; the ship is now drawn as real art, with chemical burns at
       the two ends and an honest coast in between. */
    if (inPork && pcCruise) {
      var t = viewJD - pcCruise.info.dep;
      var stt = A.propagateKepler(pcCruise.info.m.rDep, pcCruise.info.m.v1, t);
      var shipR = stt.r, shipV = stt.v;
      pcCruise.trail.push([shipR[0], shipR[1], shipR[2]]);
      if (pcCruise.trail.length > 110) pcCruise.trail.shift();
      ctx.lineWidth = 1.5;
      var P3 = SEGA, P4 = SEGB;
      for (var k3 = 1; k3 < pcCruise.trail.length; k3++) {
        var a3 = pcCruise.trail[k3 - 1], b3 = pcCruise.trail[k3];
        if (!projectSeg(a3[0], a3[1], a3[2], b3[0], b3[1], b3[2])) continue;
        ctx.globalAlpha = 0.5 * (k3 / pcCruise.trail.length);
        ctx.strokeStyle = accent();
        ctx.beginPath(); ctx.moveTo(P3.x, P3.y); ctx.lineTo(P4.x, P4.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (projectPt(shipR[0], shipR[1], shipR[2], PRJ)) {
        var sxp2 = PRJ.x, syp2 = PRJ.y;
        /* screen direction of travel, for the nose and the plume */
        var ang = 0;
        if (shipV && projectPt(shipR[0] + shipV[0] * 6, shipR[1] + shipV[1] * 6,
                               shipR[2] + shipV[2] * 6, SEGA)) {
          var aa2 = Math.atan2(SEGA.y - syp2, SEGA.x - sxp2);
          if (isFinite(aa2)) ang = aa2;
        }
        var fr2 = pcCruise.info.tof > 0 ? clampN(t / pcCruise.info.tof, 0, 1) : 0;
        var burn = 0;
        if (fr2 < 0.08) burn = 1 - fr2 / 0.08;
        else if (fr2 > 0.92) burn = (fr2 - 0.92) / 0.08;
        if (SHIPS) {
          if (burn > 0.01) {
            /* start the flame at the TAIL, not the ship's centre: drawn from
               the centre its bright core lands under the opaque hull and the
               whole burn reads as a dark smear */
            var PSZ = 62, tailK = 21;
            SHIPS.drawChemPlume(ctx, sxp2 - Math.cos(ang) * tailK, syp2 - Math.sin(ang) * tailK,
                                PSZ, ang + Math.PI, burn, now / 1000, { light: isLight() });
          }
          ctx.save();
          ctx.translate(sxp2, syp2);
          ctx.rotate(ang);
          SHIPS.drawShip(ctx, 0, 0, 46, -0.55, {
            key: shipKeyOf(accelIdx), thrust: 0, t: now / 1000, quality: 0, flip: 0,
            light: isLight()
          });
          ctx.restore();
        } else {
          ctx.fillStyle = textColor(0.95);
          ctx.beginPath(); ctx.arc(sxp2, syp2, 2.6, 0, 6.2832); ctx.fill();
        }
      }
    }
    /* soft ring pulse on porkchop arrival */
    if (inPork && arrivedPulse && !reduced && pcTarget) {
      var kp = (now - arrivedPulse) / 1400;
      var pt = planetScr[PLANET_KEYS.indexOf(pcTarget)];
      if (kp < 1 && pt.ok) {
        ctx.strokeStyle = gold();
        ctx.globalAlpha = 0.7 * (1 - kp);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 8 + kp * 26, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ==================================================================
     Close-ups. The star orb, the exoplanet orbs and the little ship in
     orbit all live here. Every VoyageArt call is fed NaN-guarded numbers:
     a NaN into createRadialGradient throws, and one throw in the rAF loop
     kills the page for good.
     ================================================================== */
  var exoScr = [];                     /* exoplanet screens, for taps */
  var starOrbPx = 0;                   /* last drawn star-orb radius */
  var lastOrbBlend = 0;                /* PURE.orbBlend of the centered star */
  var starSprites = 0;                 /* centered-star sprite draws, for QA */

  function orbQuality() { return (W <= 768 || reduced) ? 0 : 1; }

  /* A close-up orb is a lit body hanging in space, and space is dark even on
     the light theme. Without this, a hot white star all but vanishes against
     the near-white sky. Light theme only; the dark sky already does the job.
     Drawn UNDER the orb, so it never touches the body's own colours. */
  var ORB_SEL_MAX = 40;      /* past this drawn radius the orb IS the selection */
  function orbBacking(cx0, cy0, rpx, fade) {
    if (!isLight()) return;
    if (!isFinite(cx0) || !isFinite(cy0) || !(rpx > 16)) return;
    var r2 = rpx * 2.5;
    var g = ctx.createRadialGradient(cx0, cy0, rpx * 0.6, cx0, cy0, r2);
    var a = clampN(0.5 * (fade == null ? 1 : fade), 0, 1);
    g.addColorStop(0, 'rgba(14,16,20,' + a + ')');
    g.addColorStop(0.45, 'rgba(14,16,20,' + (a * 0.42) + ')');
    g.addColorStop(1, 'rgba(14,16,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx0, cy0, r2, 0, 6.2832); ctx.fill();
  }

  /* fallback blob for the case where voyage-art.js failed to load */
  function drawStarBlob(cx0, cy0, rpx, T, fade) {
    var rgb = isFinite(T) ? A.kelvinToRgb(T) : { r: 214, g: 218, b: 228 };
    if (!isFinite(cx0) || !isFinite(cy0) || !(rpx > 0)) return;
    var grad = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, rpx * 2.2);
    grad.addColorStop(0, 'rgba(255,255,255,' + (0.95 * fade) + ')');
    grad.addColorStop(0.28, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.9 * fade) + ')');
    grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx0, cy0, rpx * 2.2, 0, 6.2832); ctx.fill();
  }

  /* star disc size: brightness-derived as before, but allowed to grow with
     the zoom so people can really look at one (still not to scale).

     Past ORB_HOLD_AU the radius used to be a CONSTANT, which is why the orb
     vanished the instant the old D < 200 switch fired and left 200 to 5000 AU
     showing nothing but the background fill. It now shrinks continuously,
     slowly (K_SHRINK 0.40, so a doubling of distance costs a quarter of the
     radius), and PURE.orbBlend fades what is left into the atlas sprite. */
  var ORB_HOLD_AU = PURE.ORB_HOLD_AU, K_SHRINK = PURE.K_SHRINK;
  function starOrbRadius(i, D) {
    var Rsun = A.starRadiusSun(starBolLum(i), starTempOf(i));
    var base = isFinite(Rsun)
      ? clampN(18 + 16 * Math.log(Math.max(1e-3, Rsun)) / Math.LN10, 6, 60)
      : 8;
    if (!(D > 0)) return base;
    var lim = Math.max(base, Math.min(H * 0.38, 300));
    if (D <= ORB_HOLD_AU) return clampN(base * (ORB_HOLD_AU / D), base, lim);
    return base * Math.pow(ORB_HOLD_AU / D, K_SHRINK);
  }

  /* One small ship on a tilted orbit ellipse around a body it is parked at.
     rBody is the drawn radius of that body in px. */
  function drawParkedShip(cx0, cy0, rBody, now, fade) {
    if (!SHIPS || !isFinite(cx0) || !isFinite(cy0) || !(rBody > 0)) return;
    var orbR = Math.max(rBody * 1.7, 22);
    var th = reduced ? 0.9 : (now / 4200) % 6.2832;
    var ex = cx0 + orbR * Math.cos(th);
    var ey = cy0 + orbR * 0.34 * Math.sin(th);
    if (!isFinite(ex) || !isFinite(ey)) return;
    ctx.save();
    ctx.globalAlpha = clampN(0.45 * fade, 0, 1);
    ctx.strokeStyle = textColor(0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var q = 0; q <= 48; q++) {
      var a2 = q / 48 * 6.2832;
      var px2 = cx0 + orbR * Math.cos(a2), py2 = cy0 + orbR * 0.34 * Math.sin(a2);
      if (q === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
    }
    ctx.stroke();
    ctx.globalAlpha = clampN(fade, 0, 1);
    /* the real ship, sized against whatever it is orbiting: a marker that is
       recognisably THIS trip's rocket beats a grey wedge */
    var spx = clampN(rBody * 1.15, 16, 60);
    SHIPS.drawShip(ctx, ex, ey, spx, -0.5, {
      key: shipKeyOf(accelIdx), thrust: 0, t: now / 1000, quality: 0, flip: 0,
      light: isLight()
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* D4. The old version switched the whole close-up off at D = 200 AU and
     the star tiers only fade IN at 5,000, so everything between the two was
     a screen full of nothing but bg(). There is no switch left: the orb
     shrinks continuously, orbBlend cross-fades it against this one star's
     atlas sprite, and the sprite is drawn whatever the distance. */
  function drawCenteredStar(D, now, sa) {
    exoScr.length = 0;
    starOrbPx = 0;
    lastOrbBlend = 0;
    var i = centeredStar;
    if (i < 0 || i >= NS) return;
    var P = PRJ;
    if (!projectPt(starX[i], starY[i], starZ[i], P)) return;
    var cx0 = P.x, cy0 = P.y;
    if (!isFinite(cx0) || !isFinite(cy0)) return;
    var rpx = starOrbRadius(i, D);
    var fade = PURE.orbBlend(rpx);
    lastOrbBlend = fade;
    starOrbPx = fade > 0 ? rpx : 0;

    /* The sprite. One drawImage, at the orb's own projected position, at the
       16 px the star field draws every other star at. It writes no scrOk
       entry and is neither hoverable nor clickable: this is the star that is
       already centered, and `sa`, `starsVis` and the 65,000-point tiers are
       deliberately left exactly as they were. */
    var sa0 = (typeof sa === 'number' && isFinite(sa)) ? clampN(sa, 0, 1) : 0;
    var spriteA = Math.max(sa0 * BAND_A[PURE.bandOf(SD.stars.mag[i])], 1 - fade);
    if (spriteA > 0.004) {
      var at0 = ensureAtlas();
      ctx.globalAlpha = clampN(spriteA, 0, 1);
      ctx.drawImage(at0, starCellX[i], starCellY[i], 32, 32, cx0 - 8, cy0 - 8, 16, 16);
      ctx.globalAlpha = 1;
      starSprites++;
    }
    if (fade <= 0) return;

    orbBacking(cx0, cy0, rpx, fade);
    var art = starArtOf(i);
    if (art) {
      orbDrawStar(ctx, cx0, cy0, rpx, art, orbT(now),
                  { quality: orbQuality(), alpha: fade }, true);
    } else {
      drawStarBlob(cx0, cy0, rpx, starTempOf(i), fade);
    }
    /* arrival pulse */
    if (starPulse && !reduced) {
      var kp = (now - starPulse) / 1400;
      if (kp < 1) {
        ctx.strokeStyle = gold();
        ctx.globalAlpha = 0.7 * (1 - kp) * fade;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx0, cy0, rpx + kp * 40, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      } else starPulse = 0;
    }
    if (mode !== 'cruise' && shipAt.kind === 's' && shipAt.idx === i) {
      drawParkedShip(cx0, cy0, rpx, now, fade);
    }
    /* known planets: real orbit sizes (a in AU), illustrative positions.
       Below half blend the host star itself is under 4 px, so its planets
       are far smaller than a pixel: the orbs are not drawn and, separately,
       nothing is pushed to exoScr. The MODE gate on exoScr is load-bearing
       and is NOT the same rule as the blend gate: during a cruise capture
       the destination becomes the centered star at close range, and a tap
       there means skip-to-arrival, never "open a planet card". */
    if (fade < 0.5) return;
    var exoTappable = (mode === 'explore');
    var list = starPlanets[i];
    if (!list || !list.length) return;
    var tAnim = reduced ? 0 : now / 1000 / 600;   /* 600 s per Earth-year of sweep */
    for (var k = 0; k < list.length; k++) {
      var j = list[k];
      var a = SD.planets.a[j];
      var per = SD.planets.per[j];
      if ((a == null || !isFinite(a)) && per != null && isFinite(per) && per > 0) {
        a = Math.pow(per / 365.25, 2 / 3);
      }
      if (a == null || !isFinite(a) || a <= 0) continue;
      var pYr = (per != null && isFinite(per) && per > 0) ? per / 365.25 : Math.pow(a, 1.5);
      var ph = k * 2.399 + (reduced ? 0 : tAnim * 2 * Math.PI / Math.max(1e-4, pYr));
      /* orbit circle in the ecliptic plane around the star */
      ctx.strokeStyle = 'rgba(127,127,127,0.9)';
      ctx.globalAlpha = 0.35 * fade;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var open = false;
      for (var q2 = 0; q2 <= 64; q2++) {
        var th = q2 / 64 * 2 * Math.PI;
        var wx2 = starX[i] + a * Math.cos(th), wy2 = starY[i] + a * Math.sin(th);
        if (projectPt(wx2, wy2, starZ[i], PRJ)) {
          if (!open) { ctx.moveTo(PRJ.x, PRJ.y); open = true; } else ctx.lineTo(PRJ.x, PRJ.y);
        } else open = false;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      var wx3 = starX[i] + a * Math.cos(ph), wy3 = starY[i] + a * Math.sin(ph);
      if (projectPt(wx3, wy3, starZ[i], PRJ)) {
        var isSel = selExo === j;
        var ex2 = PRJ.x, ey2 = PRJ.y;
        var eart = exoArtOf(j);
        /* size the orb from the orbit's own on-screen radius: a selected
           planet grows as the camera closes in, everything else stays a
           small orb that reads as a dot on the ring */
        var orbitPx = fpxV * a / Math.max(1e-6, D);
        var er = isSel ? clampN(orbitPx * 0.28, 10, 120)
                       : clampN(orbitPx * 0.10, 8, 14);
        if (!isFinite(er) || er <= 0) er = 9;
        if (eart) {
          var ld = Math.atan2(cy0 - ey2, cx0 - ex2);   /* lit from the star */
          if (!isFinite(ld)) ld = Math.PI;
          /* the space vignette is there to lift an orb off a near-white SKY;
             over the host star's own bright disc it is just a brown smudge */
          if (Math.hypot(ex2 - cx0, ey2 - cy0) > rpx + er) orbBacking(ex2, ey2, er, fade);
          /* exoplanet orbs stay on VoyageArt: D1 reserves the two GL blits
             for the close-up body and the cruise destination */
          orbDrawPlanet(ctx, ex2, ey2, er, eart, orbT(now),
                        { quality: orbQuality(), lightDir: ld, alpha: fade }, false);
        } else {
          ctx.globalAlpha = fade;
          ctx.fillStyle = isSel ? gold() : textColor(0.85);
          ctx.beginPath(); ctx.arc(ex2, ey2, 3, 0, 6.2832); ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (isSel) {
          if (er <= ORB_SEL_MAX) {
            ctx.strokeStyle = gold();
            ctx.globalAlpha = clampN(0.85 * fade, 0, 1);
            ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc(ex2, ey2, er + 5, 0, 6.2832); ctx.stroke();
            ctx.globalAlpha = 1;
          }
          /* the same honesty line the card carries, next to the close-up. It
             sits over the host star's disc more often than not, so it gets a
             backing plate: this sentence has to be readable, always. */
          if (er >= 26) {
            captionPlate([
              'An impression drawn from its measured size and temperature.',
              'Nobody has seen this planet up close.'
            ], clampN(ex2, W * 0.24, W * 0.76), ey2 + er + 12, W < 700 ? 10 : 11.5);
          }
        }
        if (exoTappable) exoScr.push({ j: j, x: ex2, y: ey2, r: er });
      } else if (exoTappable) {
        exoScr.push({ j: j, x: -9999, y: -9999, r: 3 });
      }
    }
  }

  function drawTag(x, y, txt, color, ringR, faint) {
    if (y < 40) return;                       /* nav dead zone: skip entirely */
    ctx.strokeStyle = color;
    ctx.globalAlpha = faint ? 0.5 : 0.95;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, ringR, 0, 6.2832); ctx.stroke();
    ctx.font = '12px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    var ty = y < H * 0.17 ? y + ringR + 10 : y - ringR - 9;
    ctx.fillText(txt, x + ringR + 4, ty);
    ctx.globalAlpha = 1;
  }

  function drawSelectionRings() {
    if (hover && hover.kind === 's' && starsVis && scrOk[hover.idx] &&
        !(sel && sel.kind === 's' && sel.idx === hover.idx)) {
      drawTag(scrX[hover.idx], scrY[hover.idx], starName(hover.idx), textColor(0.75), 9, true);
    }
    if (sel && sel.kind === 's') {
      var i = sel.idx;
      if (starsVis && scrOk[i]) {
        drawTag(scrX[i], scrY[i], starName(i), gold(), 9, false);
      } else if (centeredStar === i && camD < 200 && starOrbPx <= ORB_SEL_MAX) {
        /* once the orb is big the orb IS the selection: a gold ring and a name
           printed across its middle only get in the way (the card names it) */
        var P = PRJ;
        if (projectPt(starX[i], starY[i], starZ[i], P)) {
          drawTag(P.x, P.y, starName(i), gold(), 14, false);
        }
      }
    }
  }

  function drawScaleBar(D) {
    sbRect = null;
    if (mode === 'porkchop' || mode === 'cruise') return;
    if (cardOpen() && W <= 768) return;      /* the sheet covers that region */
    var auPerPx = D / fpxV;
    var mobile = W <= 768;
    var maxPx = mobile ? Math.min(W * 0.5, W - 32) : Math.min(260, W - 280, W * 0.3);
    var ns = PURE.niceScale(auPerPx, maxPx, LY_AU);
    if (!ns) return;
    var y = mobile ? Math.max(40, cornerBand().top - 8) : H - 12;
    var x0 = (W - ns.px) / 2, x1 = x0 + ns.px;
    ctx.strokeStyle = textColor(0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 4); ctx.lineTo(x0, y + 0.5);
    ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 0.5);
    ctx.stroke();
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.65);
    ctx.fillText(ns.label, (x0 + x1) / 2, y - 5);
    sbRect = { x: x0, y: y - 20, w: ns.px, h: 22 };
    /* Honesty whisper while a star or planet disc is on screen. It keys off
       the same blend the disc does, so it lasts exactly as long as the disc
       it is disclosing (the old D < 200 test would have gone quiet while the
       disc was still drawn). */
    if (centeredStar >= 0 && lastOrbBlend > 0) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.45);
      ctx.fillText('star disc not to scale', (x0 + x1) / 2, y - 20);
    } else if (planetOrbIdx >= 0) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.45);
      ctx.fillText('planet disc not to scale', (x0 + x1) / 2, y - 20);
    }
    ctx.textAlign = 'left';
  }

  function drawTimeline() {
    var tl = L.tl, r = tlRange();
    function jdToX(jd) { return tl.x0 + (jd - r.min) / (r.max - r.min) * (tl.x1 - tl.x0); }
    ctx.strokeStyle = 'rgba(127,127,127,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tl.x0, tl.y); ctx.lineTo(tl.x1, tl.y); ctx.stroke();
    var info = selInfo();
    if (info) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent();
      var xd = jdToX(info.dep);
      ctx.beginPath(); ctx.moveTo(xd, tl.y - 5); ctx.lineTo(xd, tl.y + 5); ctx.stroke();
      ctx.strokeStyle = gold();
      var xa = jdToX(info.dep + info.tof);
      ctx.beginPath(); ctx.moveTo(xa, tl.y - 5); ctx.lineTo(xa, tl.y + 5); ctx.stroke();
    }
    var xh = clampN(jdToX(viewJD), tl.x0, tl.x1);
    ctx.fillStyle = accent();
    ctx.beginPath(); ctx.arc(xh, tl.y, 5.5, 0, 6.2832); ctx.fill();
    ctx.font = '13px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.85);
    ctx.fillText(fmtDate(viewJD), tl.x0, tl.y - 9);
  }

  function drawPorkchop() {
    var job = jobs[pcTarget], sp = specOf(pcTarget);
    var pc = L.pc, plot = L.plot;
    ctx.fillStyle = panelFill();
    ctx.strokeStyle = 'rgba(127,127,127,0.28)';
    ctx.lineWidth = 1;
    roundRect(pc.x, pc.y, pc.w, pc.h, 10);
    ctx.fill(); ctx.stroke();

    if (pcCache) ctx.drawImage(pcCache, plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = 'rgba(127,127,127,0.3)';
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    var n = sp.nDep, m = sp.nTof;
    ctx.font = '10.5px ' + FONT;
    ctx.fillStyle = textColor(0.65);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var stepMonths = L.mobile ? 12 : 6;
    var d0 = A.jdToDate(sp.jd0), dEnd = A.jdToDate(sp.depMax);
    var mm = d0.m, yy = d0.y;
    for (var guard = 0; guard < 45; guard++) {
      mm++; if (mm > 12) { mm = 1; yy++; }
      if (yy > dEnd.y || (yy === dEnd.y && mm > dEnd.m)) break;
      if (((yy * 12 + mm - 1) % stepMonths) !== 0) continue;
      var tj = A.dateToJD(yy, mm, 1);
      var tx = plot.x + ((tj - sp.jd0) / sp.depStep + 0.5) / n * plot.w;
      if (tx < plot.x + 14 || tx > plot.x + plot.w - 14) continue;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(tx, plot.y + plot.h); ctx.lineTo(tx, plot.y + plot.h + 4); ctx.stroke();
      ctx.fillText(MON[mm - 1] + " '" + String(yy % 100 < 10 ? '0' + yy % 100 : yy % 100), tx, plot.y + plot.h + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var tofTick = PURE.tofTickFor(sp.tofMax - sp.tof0);
    for (var tv = Math.ceil(sp.tof0 / tofTick) * tofTick; tv <= sp.tofMax; tv += tofTick) {
      var ty = plot.y + plot.h - ((tv - sp.tof0) / sp.tofStep + 0.5) / m * plot.h;
      if (ty < plot.y + 6 || ty > plot.y + plot.h - 4) continue;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(plot.x - 4, ty); ctx.lineTo(plot.x, ty); ctx.stroke();
      ctx.fillText(PURE.fmtInt(tv) + ' d', plot.x - 7, ty);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = textColor(0.6);
    ctx.fillText('total Δv, km/s', plot.x + plot.w - 5, plot.y + 4);

    if (job && !job.done) {
      ctx.fillStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.fillRect(plot.x, plot.y + plot.h - 3, plot.w * job.progress, 3);
      ctx.globalAlpha = 1;
    }

    var s = pcSel[pcTarget];
    if (s) {
      var cx2 = plot.x + (s.i + 0.5) / n * plot.w;
      var cy2 = plot.y + plot.h - (s.j + 0.5) / m * plot.h;
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, cy2); ctx.lineTo(plot.x + plot.w, cy2);
      ctx.moveTo(cx2, plot.y); ctx.lineTo(cx2, plot.y + plot.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6;
      ctx.strokeRect(cx2 - 3.5, cy2 - 3.5, 7, 7);
    }

    drawReadout(job);
  }

  function drawReadout(job) {
    var ro = L.ro;
    var info = selInfo();
    var xL = ro.x + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (!info || !job) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      var msg = job && !job.done
        ? ('Computing the Δv map · ' + Math.round(job.progress * 100) + '%')
        : 'Pick a spot on the map.';
      ctx.fillText(msg, xL, ro.y + (L.mobile ? 24 : 34));
      return;
    }
    if (!info.m) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      ctx.fillText('No transfer here. This geometry needs more than one arc.', xL, ro.y + (L.mobile ? 24 : 34));
      if (!L.mobile) {
        ctx.fillText('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days', xL, ro.y + 56);
      }
      return;
    }
    var m2 = info.m;
    var extrap = (info.dep + info.tof) > JD_EXTRAP;
    if (L.mobile) {
      ctx.font = '12.5px ' + FONT;
      ctx.fillStyle = textColor(0.85);
      ctx.fillText(fmtDate(info.dep) + ' · ' + info.tof + ' d · arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 19);
      ctx.font = '600 13px ' + FONT;
      ctx.fillText('Δv ' + m2.dv1.toFixed(2) + ' + ' + m2.dv2.toFixed(2) + ' = ' + m2.total.toFixed(2) + ' km/s total', xL, ro.y + 38);
      if (extrap) {
        ctx.font = '9.5px ' + FONT;
        ctx.fillStyle = textColor(0.55);
        ctx.fillText('Arrival past 2050: JPL elements extrapolated slightly beyond their fit.', xL, ro.y + 50);
      }
      return;
    }
    ctx.font = '13px ' + FONT;
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Depart ' + fmtDate(info.dep) + '  ·  Arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 24);
    ctx.font = '12.5px ' + FONT;
    ctx.fillStyle = textColor(0.7);
    ctx.fillText('Flight time ' + info.tof + ' days · C3 ' + m2.c3.toFixed(1) + ' km²/s² · v∞ arrival ' + m2.vinfArr.toFixed(2) + ' km/s', xL, ro.y + 45);
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Δv depart ' + m2.dv1.toFixed(2) + ' · Δv arrive ' + m2.dv2.toFixed(2), xL, ro.y + 68);
    if (extrap) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.55);
      ctx.fillText('Arrival dates past 2050 extrapolate the JPL elements slightly beyond their fitted range.', xL, ro.y + 84);
    }
    ctx.font = '700 15px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = textColor(0.95);
    ctx.fillText('Total Δv ' + m2.total.toFixed(2) + ' km/s', ro.x + ro.w - 14, ro.y + 68);
    ctx.textAlign = 'left';
    /* the ship may be parked somewhere else; the map is still the classic
       Earth-departure map, and it says so rather than quietly implying it */
    if (!(shipAt.kind === 'p' && shipAt.idx === 2)) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.55);
      ctx.fillText('transfer numbers are computed for the classic Earth departure window.',
                   xL, ro.y + (extrap ? 96 : 84));
    }
  }

  function draw(now) {
    if (!W || !H) { resize(); if (!W || !H) return; layout(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);
    /* One frame, at most GL_MAX_BLITS orb blits: tell VoyageGL the frame
       started so the budget is per frame and not per call. This takes the
       WALL clock, never orbT: VoyageGL resets the counter when the time it
       is handed CHANGES, and under reduced motion every orb passes tSec 0
       forever, so without a moving frame stamp the budget would fill up
       after two frames and never refill. */
    var Gl = GL();
    if (Gl && Gl.beginFrame) Gl.beginFrame(now / 1000);
    /* hold the GL context open through a cinematic: a cruise goes ten
       seconds with no orb over GL_MIN_R, which used to trip the idle
       release and buy a context re-creation mid-flight */
    if (Gl && Gl.setHold) Gl.setHold(mode === 'cruise' || !!pcCruise);
    updateCamBasis();
    var D = camD;
    /* Past a few thousand light years the whole catalogue is a sub-pixel clump
       sitting inside the "you are here" marker, so the two star tiers fade out
       and the galaxy cloud takes over. It keeps the marker readable and it is
       what makes this zoom affordable: those tiers are 65,000 points. */
    var ga = ramp(D, 1.2e8, 1.2e9);
    var sa = ramp(D, 5e3, 3e4) * (1 - ramp(D, 1.2e8, 8e8));
    if (mode === 'cruise') sa = Math.max(sa, 0.45);   /* the sky travels with you */
    var pa = 1 - ramp(D, 250, 400);
    /* the cockpit redraws the whole sky through aberration, so the ordinary
       world passes are skipped entirely there */
    var cockpit = (mode === 'cruise' && fpMode && !reduced && cruiseSt);
    if (cockpit) {
      starsVis = false;
      scrOk.fill(0);        /* no stale screen positions survive the cockpit */
      exoScr.length = 0;
      drawCruise(now);
      drawScaleBar(D);
      drawTagline(now);
      return;
    }
    if (ga > 0.004) drawGalaxy(ga);
    starsVis = sa > 0.004;
    /* a strided star tier leaves last frame's screen position on the stars
       it skipped, so clear the flags first and let only what is really
       drawn this frame carry one */
    if (skyLod() > 0) scrOk.fill(0);
    if (starsVis) drawBgTier(sa);
    if (starsVis) drawStars(sa);
    /* From another star the Sun is just one more background star: its disc,
       the eight orbits, the planet labels and the parked-ship marker have no
       business collapsing into a point-cluster in the corner. */
    var atHome = nearSol();
    if (atHome) drawSun(D);
    if (atHome && pa > 0.01) drawSolar(pa, now);
    else { planetOrbIdx = -1; planetOrbPx = 0; }
    /* No distance switch: drawCenteredStar owns the whole ramp now, from a
       screen-filling disc down to the one atlas sprite that keeps the star
       on screen at any zoom (D4). */
    if (centeredStar >= 0 && mode !== 'porkchop') drawCenteredStar(D, now, sa);
    else { exoScr.length = 0; starOrbPx = 0; lastOrbBlend = 0; }
    drawSelectionRings();
    if (mode === 'cruise') drawCruise(now);
    if (mode === 'porkchop') { sbRect = null; drawTimeline(); drawPorkchop(); }
    else drawScaleBar(D);
    drawTagline(now);
  }

  /* ---------------- main loop ---------------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    var nowMs = performance.now();

    if (mode === 'intro') { introStep(nowMs); viewJD += dt * 10; }
    camStep(nowMs);

    var job = pcTarget ? jobs[pcTarget] : null;
    if (job && !job.done) {
      job.step(12);
      if (job.done) {
        pcDirty = true;
        if (!pcSel[pcTarget] && mode === 'porkchop') {
          setPcSel(job.minI, job.minJ, true);
          var info = selInfo();
          if (info && info.m) {
            ariaLast = nowMs; ariaPend = null;
            setStatus('Cheapest window: depart ' + fmtDate(info.dep) + ' · ' + info.tof +
                      ' days · ' + info.m.total.toFixed(1) + ' km/s total');
          }
        }
      } else if (nowMs - lastPcPaint > 150) {
        pcDirty = true;
      }
    }
    if (mode === 'porkchop' && pcDirty) { renderPcCache(); lastPcPaint = nowMs; }

    if (mode === 'porkchop' && pcCruise) {
      var s = (nowMs - pcCruise.t0) / pcCruise.ms;
      if (s >= 1) {
        viewJD = pcCruise.info.dep + pcCruise.info.tof;
        var ci = pcCruise.info;
        pcCruise = null;
        arrivedPulse = nowMs;
        pcArrive(ci);
        announceArrival(ci);
        if (btnLaunch) btnLaunch.textContent = 'Replay';
      } else {
        viewJD = pcCruise.info.dep + easeInOutCubic(s) * pcCruise.info.tof;
      }
    } else if (mode === 'explore' && attract && !dragKind) {
      viewJD += dt * 4;
      cam.yaw += dt * 0.012;
    }

    if (mode === 'cruise' && cruiseSt) cruiseStep(nowMs);
    if (mode !== lastMode) {
      lastMode = mode;
      syncFpBar();
      /* a mode change re-costs the whole scene for a moment; do not let that
         moment demote a tier for the rest of the session */
      budgetHold = GOV_HOLD_MS;
    }
    stepPreviews(nowMs);

    if (ariaPend && nowMs - ariaLast > 400) {
      ariaLast = nowMs; setStatus(ariaPend); ariaPend = null;
    }
    draw(nowMs);
    frameBudget(t - lastFrameT);
    cruiseBudget(t - lastFrameT);
    lastFrameT = t;
    if (!bgTried && ++framesPainted > 1) loadBgTier();
    /* the galaxy bake starts AFTER the first painted frame, like the
       background tier: the point cloud carries the view until it lands */
    if (!galBakeTried) { galBakeTried = true; startGalaxyBake(); }
  }
  var lastFrameT = 0, framesPainted = 0, lastMode = null;
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ---------------- pointer input ---------------- */
  var pointers = {};
  var orbitDrag = null;                 /* {x0, y0, yaw0, pitch0} */
  var pinchSt = null;                   /* {d} */
  var downSt = null;                    /* {x, y, t, type} pending tap */
  function rel(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function pointerCount() { var n = 0, k; for (k in pointers) n++; return n; }
  function pvals() { var a = [], k; for (k in pointers) a.push(pointers[k]); return a; }
  function pdist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function inPlot(p) {
    return p.x >= L.plot.x && p.x <= L.plot.x + L.plot.w &&
           p.y >= L.plot.y && p.y <= L.plot.y + L.plot.h;
  }
  function nearTl(p) {
    return Math.abs(p.y - L.tl.y) < 18 && p.x > L.tl.x0 - 12 && p.x < L.tl.x1 + 12;
  }
  function pcPick(p) {
    var sp = specOf(pcTarget);
    var i = clampN(Math.floor((p.x - L.plot.x) / L.plot.w * sp.nDep), 0, sp.nDep - 1);
    var j = clampN(Math.floor((L.plot.y + L.plot.h - p.y) / L.plot.h * sp.nTof), 0, sp.nTof - 1);
    setPcSel(i, j);
  }
  function tlPick(p) {
    var r = tlRange();
    var f = clampN((p.x - L.tl.x0) / (L.tl.x1 - L.tl.x0), 0, 1);
    /* the user-facing scrub clamps at 2050; grids and cruises may pass it */
    viewJD = clampN(r.min + f * (r.max - r.min), r.min, Math.min(r.max, JD_2050));
  }

  function pickBody(p, rad) {
    var best = null, bestD = rad * rad, i, dx, dy, d2;
    /* exoplanet dots of the centered star first */
    for (i = 0; i < exoScr.length; i++) {
      dx = exoScr[i].x - p.x; dy = exoScr[i].y - p.y; d2 = dx * dx + dy * dy;
      var er2 = Math.max(rad, (exoScr[i].r || 3) + 6);
      if (d2 < er2 * er2 && d2 < Math.max(bestD, er2 * er2)) {
        bestD = d2; best = { kind: 'x', idx: exoScr[i].j };
      }
    }
    if (best) return best;
    /* planets */
    if (camD < 400) {
      for (i = 0; i < 8; i++) {
        if (!planetScr[i].ok) continue;
        dx = planetScr[i].x - p.x; dy = planetScr[i].y - p.y; d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = { kind: 'p', idx: i }; }
      }
      if (best) return best;
    }
    /* stars */
    if (starsVis) {
      for (i = 0; i < NS; i++) {
        if (!scrOk[i]) continue;
        dx = scrX[i] - p.x; dy = scrY[i] - p.y; d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = { kind: 's', idx: i }; }
      }
    } else if (centeredStar >= 0 && camD < 200) {
      var P = PRJ;
      if (projectPt(starX[centeredStar], starY[centeredStar], starZ[centeredStar], P)) {
        dx = P.x - p.x; dy = P.y - p.y;
        if (dx * dx + dy * dy < Math.pow(rad + 24, 2)) best = { kind: 's', idx: centeredStar };
      }
    }
    return best;
  }

  function tapSelect(p, type) {
    var hit = pickBody(p, type === 'touch' ? 20 : 16);
    if (!hit) {
      if (sel || cardOpen()) deselect();
      return;
    }
    if (hit.kind === 'x') {
      var host = SD.planets.host[hit.idx];
      selectBody({ kind: 's', idx: host }, { openCard: true, exo: hit.idx });
      return;
    }
    var name = hit.kind === 'p' ? PLANET_LABELS[hit.idx] : starName(hit.idx);
    var now = performance.now();
    if (lastTap && lastTap.name === name && now - lastTap.t < 350) {
      lastTap = null;
      zoomToBody(hit);
      return;
    }
    lastTap = { name: name, t: now };
    selectBody(hit, { openCard: true, fly: false });
  }

  function userTouched() {
    if (attract) { attract = false; viewJD = jdToday; }
    if (mode === 'intro') endIntro();
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button === 2) return;
    userTouched();
    var p = rel(e);
    pointers[e.pointerId] = p;
    if (pointerCount() === 2) {
      /* a second finger during a porkchop plot/timeline drag must NOT
         cancel it into a pinch (pinned input model: pinch never engages
         from a gesture that began inside those rects) */
      if (dragKind === 'pc' || dragKind === 'tl') {
        delete pointers[e.pointerId];
        return;
      }
      /* CL-39: mid-cruise a second finger is a rig-distance gesture and
         nothing else. It never cancels the free-look drag already running
         and it never synthesizes the skip tap. */
      orbitDrag = null; downSt = null; dragKind = null;
      var pts = pvals();
      pinchSt = { d: pdist(pts[0], pts[1]), rig: mode === 'cruise' };
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    /* pinned hit-test order: porkchop plot, then timeline, then orbit */
    if (mode === 'porkchop' && L) {
      if (inPlot(p)) {
        dragKind = 'pc';
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        pcPick(p);
        e.preventDefault();
        return;
      }
      if (nearTl(p)) {
        dragKind = 'tl';
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        cancelPcCruise();
        tlPick(p);
        e.preventDefault();
        return;
      }
    }
    if (mode === 'cruise') {
      /* free look. The tap that skips the cinematic is still a tap: the
         6 px threshold below is what separates them. */
      downSt = { x: p.x, y: p.y, t: performance.now(), type: e.pointerType, cruise: true };
      lookDrag = { x0: p.x, y0: p.y, yaw0: lookYaw, pitch0: lookPitch };
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    camAnim = null;                      /* grabbing the sky cancels a fly */
    orbitDrag = { x0: p.x, y0: p.y, yaw0: cam.yaw, pitch0: cam.pitch };
    downSt = { x: p.x, y: p.y, t: performance.now(), type: e.pointerType };
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    var p = rel(e);
    if (pointers[e.pointerId]) pointers[e.pointerId] = p;
    if (pinchSt) {
      var pts = pvals();
      if (pts.length < 2) return;
      var nd = pdist(pts[0], pts[1]);
      if (pinchSt.d > 0 && nd > 0) {
        if (pinchSt.rig) rigD = clampN(rigD * (pinchSt.d / nd), RIG_D_MIN, RIG_D_MAX);
        else cam.logD = clampN(cam.logD - Math.log(nd / pinchSt.d) / Math.LN10, minLogD(), MAX_LOGD);
      }
      pinchSt.d = nd;
      return;
    }
    if (lookDrag) {
      var ldx = p.x - lookDrag.x0, ldy = p.y - lookDrag.y0;
      if (downSt && Math.abs(ldx) + Math.abs(ldy) > 6) downSt = null;
      if (!downSt) {
        lookYaw = clampN(lookDrag.yaw0 - ldx * 0.005, -Math.PI, Math.PI);
        lookPitch = clampN(lookDrag.pitch0 - ldy * 0.005,
                           -Math.PI * 0.45, Math.PI * 0.45);
      }
      return;
    }
    if (dragKind === 'pc') { pcPick(p); return; }
    if (dragKind === 'tl') { tlPick(p); return; }
    if (orbitDrag) {
      var dx = p.x - orbitDrag.x0, dy = p.y - orbitDrag.y0;
      if (downSt && Math.abs(dx) + Math.abs(dy) > 6) downSt = null;
      if (!downSt) {
        cam.yaw = orbitDrag.yaw0 - dx * 0.005;
        cam.pitch = clampN(orbitDrag.pitch0 + dy * 0.005, -1.45, 1.45);
      }
      return;
    }
    /* hover (mouse, explore only) */
    if (mode === 'explore' && e.pointerType === 'mouse') {
      hover = pickBody(p, 14);
      canvas.style.cursor = hover ? 'pointer' : 'default';
    }
    if (mode === 'porkchop' && L) {
      canvas.style.cursor = inPlot(p) ? 'crosshair' : (nearTl(p) ? 'ew-resize' : 'default');
    }
  });

  function endPointer(e) {
    var p = pointers[e.pointerId] ? { x: pointers[e.pointerId].x, y: pointers[e.pointerId].y } : rel(e);
    delete pointers[e.pointerId];
    if (pinchSt) {
      if (pointerCount() < 2) {
        pinchSt = null;
        /* the finger that stayed down is still free-looking, so re-anchor
           its drag instead of letting the stale origin snap the view */
        if (lookDrag) {
          var rem = pvals()[0];
          if (rem) {
            lookDrag.x0 = rem.x; lookDrag.y0 = rem.y;
            lookDrag.yaw0 = lookYaw; lookDrag.pitch0 = lookPitch;
          } else lookDrag = null;
        }
      }
      return;                            /* ignore taps until both lift */
    }
    if (dragKind) {
      if (dragKind === 'pc' && ariaPend) {
        setStatus(ariaPend); ariaPend = null;
        ariaLast = performance.now();
      }
      dragKind = null;
      return;
    }
    if (downSt) {
      var dt2 = performance.now() - downSt.t;
      var moved = Math.abs(p.x - downSt.x) + Math.abs(p.y - downSt.y);
      if (dt2 < 350 && moved <= 6) {
        if (downSt.cruise) skipStarCruise();
        else if (mode === 'explore') tapSelect(p, downSt.type);
      }
    }
    downSt = null;
    orbitDrag = null;
    if (pointerCount() === 0) lookDrag = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', function (e) {
    delete pointers[e.pointerId];
    pinchSt = null; orbitDrag = null; downSt = null; dragKind = null;
    if (pointerCount() === 0) lookDrag = null;
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    userTouched();
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;         /* line-mode mice -> pixels */
    else if (e.deltaMode === 2) dy *= (H || 600);
    if (mode === 'cruise') {
      /* CL-09: the wheel is the rig distance here. cam.logD stays pinned as
         the input to the LOD ramps and minLogD is not consulted at all. */
      rigD = clampN(rigD * Math.exp(dy * 0.0016), RIG_D_MIN, RIG_D_MAX);
      return;
    }
    cam.logD = clampN(cam.logD + dy * 0.005 / Math.LN10, minLogD(), MAX_LOGD);
  }, { passive: false });

  /* ---------------- keyboard (one consumer per key per mode) ------------ */
  function escLadder() {
    if (mode === 'cruise') { skipStarCruise(); return; }
    if (mode === 'porkchop') {
      if (pcCruise) { cancelPcCruise(); setStatus('Cruise cancelled.'); return; }
      exitPorkchop();
      return;
    }
    if (cardOpen()) { closeCard(); return; }
  }
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    var k = e.key;
    /* Escape runs the page ladder FIRST, before the interactive-element
       guard below. That guard exists so Enter and Space keep belonging to a
       focused control (the four-in-a-row lesson), and Escape is never a
       control's key: leaving it behind the guard meant that clicking the
       cruise HUD's own info button disarmed Esc-to-skip for the rest of the
       flight, which is the one key the hint text promises. */
    if (k === 'Escape') {
      if (mode === 'intro') { endIntro(); return; }
      attract = false;
      escLadder();
      return;
    }
    if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'label') return;
    if (mode === 'intro') { endIntro(); }
    attract = false;
    if (k === 'v' || k === 'V') {
      /* one consumer per key: V only means anything mid-cruise */
      if (mode === 'cruise' && !reduced) { setFpMode(!fpMode); e.preventDefault(); }
      return;
    }
    if (mode === 'cruise') return;           /* everything else inert */
    if (k === '+' || k === '=') {
      cam.logD = clampN(cam.logD - 0.15, minLogD(), MAX_LOGD);
      e.preventDefault();
      return;
    }
    if (k === '-' || k === '_') {
      cam.logD = clampN(cam.logD + 0.15, minLogD(), MAX_LOGD);
      e.preventDefault();
      return;
    }
    if (mode === 'porkchop') {
      if (k === 'Enter') { e.preventDefault(); pcLaunch(); return; }
      var di = 0, dj = 0;
      if (k === 'ArrowLeft') di = -1;
      else if (k === 'ArrowRight') di = 1;
      else if (k === 'ArrowUp') dj = 1;
      else if (k === 'ArrowDown') dj = -1;
      else return;
      e.preventDefault();
      var stp = e.shiftKey ? 5 : 1;
      var sp = specOf(pcTarget);
      var s = pcSel[pcTarget] || { i: Math.round(sp.nDep / 2), j: Math.round(sp.nTof / 2) };
      setPcSel(clampN(s.i + di * stp, 0, sp.nDep - 1), clampN(s.j + dj * stp, 0, sp.nTof - 1));
      return;
    }
    /* explore */
    if (k === 'Enter') {
      if (sel && !cardOpen()) { openCardFor(sel); e.preventDefault(); }
      return;
    }
    if (k === 'ArrowLeft') { cam.yaw += 0.08; e.preventDefault(); }
    else if (k === 'ArrowRight') { cam.yaw -= 0.08; e.preventDefault(); }
    else if (k === 'ArrowUp') { cam.pitch = clampN(cam.pitch + 0.06, -1.45, 1.45); e.preventDefault(); }
    else if (k === 'ArrowDown') { cam.pitch = clampN(cam.pitch - 0.06, -1.45, 1.45); e.preventDefault(); }
  });

  /* ---------------- search combobox ---------------- */
  var searchHits = [], searchHi = -1;
  function closeSearchList() {
    if (!elList) return;
    elList.hidden = true;
    elList.innerHTML = '';
    searchHits = []; searchHi = -1;
    if (elSearch) {
      elSearch.setAttribute('aria-expanded', 'false');
      elSearch.removeAttribute('aria-activedescendant');
    }
  }
  function renderSearchList() {
    if (!elList) return;
    elList.innerHTML = '';
    if (!searchHits.length) { closeSearchList(); return; }
    elList.hidden = false;
    if (elSearch) elSearch.setAttribute('aria-expanded', 'true');
    for (var i = 0; i < searchHits.length; i++) {
      (function (qi) {
        var h = searchHits[qi];
        var li = el('li', 'voy-search__opt', '');
        li.id = 'voy-opt-' + qi;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', qi === searchHi ? 'true' : 'false');
        if (qi === searchHi) li.classList.add('voy-search__opt--hi');
        li.appendChild(el('span', null, h.label));
        li.appendChild(el('span', 'voy-search__kind',
          h.kind === 'p' ? 'planet' : (h.kind === 'x' ? 'exoplanet' : 'star')));
        li.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
        li.addEventListener('click', function () { chooseSearch(qi); });
        elList.appendChild(li);
      })(i);
    }
    if (elSearch) {
      if (searchHi >= 0) elSearch.setAttribute('aria-activedescendant', 'voy-opt-' + searchHi);
      else elSearch.removeAttribute('aria-activedescendant');
    }
  }
  function chooseSearch(qi) {
    var h = searchHits[qi];
    if (!h) return;
    closeSearchList();
    if (elSearch) elSearch.value = h.label;
    userTouched();   /* a search during the intro must end it, or introStep
                        keeps overriding the flyTo camera */
    if (mode === 'porkchop') exitPorkchop();
    cancelStarCruise(true);
    if (h.kind === 'p') {
      selectBody({ kind: 'p', idx: h.idx }, { openCard: true, fly: true });
    } else if (h.kind === 's') {
      selectBody({ kind: 's', idx: h.idx }, { openCard: true, fly: true });
    } else {
      var host = SD.planets.host[h.idx];
      selectBody({ kind: 's', idx: host }, { openCard: true, fly: true, exo: h.idx });
    }
  }
  if (elSearch) {
    elSearch.addEventListener('input', function () {
      searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
      searchHi = searchHits.length ? 0 : -1;
      renderSearchList();
    });
    elSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!elList.hidden) {
          closeSearchList();
          e.stopPropagation();             /* Esc closes the list ONLY */
          e.preventDefault();
        }
        return;
      }
      if (elList.hidden) {
        if (e.key === 'ArrowDown' && elSearch.value) {
          searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
          searchHi = searchHits.length ? 0 : -1;
          renderSearchList();
          e.preventDefault();
        }
        if (e.key === 'Enter' && elSearch.value) {
          searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
          if (searchHits.length) chooseSearch(0);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        searchHi = (searchHi + 1) % searchHits.length;
        renderSearchList();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        searchHi = (searchHi - 1 + searchHits.length) % searchHits.length;
        renderSearchList();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (searchHi >= 0) chooseSearch(searchHi);
        e.preventDefault();
      }
    });
    elSearch.addEventListener('blur', function () {
      setTimeout(closeSearchList, 150);
    });
  }

  /* ---------------- share / save ---------------- */
  function sharePayload() {
    if (!sel) return null;
    var o = { a: accelIdx, m: shipIdx };
    if (sel.kind === 'p') {
      o.t = ['p', PLANET_LABELS[sel.idx]];
      if (mode === 'porkchop' && pcSel[pcTarget]) {
        var info = selInfo();
        if (info) { o.d = info.dep; o.f = info.tof; }
      }
    } else if (selExo >= 0) {
      o.t = ['x', SD.planets.name[selExo]];
    } else {
      o.t = ['s', starName(sel.idx)];
    }
    return o;
  }
  if (btnShare) btnShare.addEventListener('click', function () {
    var o = sharePayload();
    if (!o) { setStatus('Pick a destination first.'); return; }
    if (window.ShareHash) ShareHash.copyLink(btnShare, ShareHash.encode(1, o));
  });
  if (btnSave) btnSave.addEventListener('click', function () {
    if (!window.ShareHash) return;
    var BAND = 46;
    var out = document.createElement('canvas');
    out.width = W; out.height = H + BAND;
    var g = out.getContext('2d');
    if (!g) return;
    g.fillStyle = bg();
    g.fillRect(0, 0, W, H + BAND);
    try { g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, W, H); } catch (e2) { return; }
    var l1 = 'The solar system on ' + fmtDate(viewJD), l2 = '';
    if (mode === 'porkchop' && pcTarget) {
      var info = selInfo();
      l1 = 'Earth to ' + PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)];
      if (info && info.m) {
        l1 += ' · depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days';
        l2 = 'Total Δv ' + info.m.total.toFixed(2) + ' km/s';
      }
    } else if (sel && sel.kind === 's') {
      var i = sel.idx;
      var gg = A.ACCEL_PRESETS[accelIdx];
      var b = A.brachistochrone(starLyD[i], gg);
      l1 = starName(i) + ' · ' + PURE.distPhrase(starLyD[i]);
      l2 = 'Constant ' + gg + ' g: ' + PURE.fmtYears(b.shipYears) + ' on the ship, ' +
        PURE.fmtYears(b.earthYears) + ' on Earth · peak ' + PURE.fmtSpeedC(b.vPeakC) + 'c';
    } else if (sel && sel.kind === 'p') {
      l1 = PLANET_LABELS[sel.idx] + ' · the solar system on ' + fmtDate(viewJD);
    }
    g.font = '600 13px ' + FONT;
    g.textBaseline = 'middle';
    g.fillStyle = textColor(0.9);
    g.fillText(l1, 12, H + 15);
    g.font = '12px ' + FONT;
    g.fillStyle = textColor(0.7);
    if (l2) g.fillText(l2, 12, H + 33);
    ShareHash.savePng(out, {
      label: 'Mission to Anywhere', file: 'voyage.png',
      light: isLight(), bg: bg()
    });
  });

  function restoreFromHash() {
    if (!window.ShareHash) return false;
    var dec = ShareHash.decode(ShareHash.readHash());
    if (!dec || dec.version !== 1) return false;
    var res = PURE.normShare(dec.obj);
    if (!res) return false;
    accelIdx = res.a; shipIdx = res.m;
    if (res.kind === 'p') {
      var pi = -1;
      for (var q = 0; q < PLANET_LABELS.length; q++) {
        if (PLANET_LABELS[q].toLowerCase() === res.name.toLowerCase()) { pi = q; break; }
      }
      if (pi < 0 || PLANET_KEYS[pi] === 'earth') return false;
      if (res.d != null && res.f != null) {
        /* a shared PLANNED trip keeps its departure/TOF pick */
        skipIntroTo(6.3);
        enterPorkchop(pi, true);
        var cs = A.clampShare({ t: PLANET_KEYS[pi], d: res.d, f: res.f }, specOf(PLANET_KEYS[pi]));
        setPcSel(cs.i, cs.j, true);
        return true;
      }
      skipIntroTo(6.3);
      selectBody({ kind: 'p', idx: pi }, { openCard: true, fly: true, instant: true });
      return true;
    }
    if (res.kind === 's') {
      var si = starIndexByName(res.name);
      if (si < 0) return false;
      skipIntroTo(6.3);
      selectBody({ kind: 's', idx: si }, { openCard: true, fly: true, instant: true, trip: true });
      return true;
    }
    var xi = exoIndexByName(res.name);
    if (xi < 0) return false;
    skipIntroTo(6.3);
    selectBody({ kind: 's', idx: SD.planets.host[xi] },
               { openCard: true, fly: true, instant: true, exo: xi });
    return true;
  }

  /* ---------------- chase / cockpit toggle ---------------- */
  var elFpBar = id('voy-fp'), elFpChase = id('voy-fp-chase'), elFpCockpit = id('voy-fp-cockpit');
  var FP_KEY = 'voy-fp';
  (function loadFp() {
    if (reduced) return;
    try {
      if (window.sessionStorage && sessionStorage.getItem(FP_KEY) === '1') fpMode = true;
    } catch (e7) { /* private mode */ }
  })();
  function syncFpBar() {
    var show = (mode === 'cruise') && !reduced && !!elFpBar;
    if (elFpBar) {
      elFpBar.hidden = !show;
      /* park it right under the canvas HUD, which floats at H*0.16 */
      if (show) elFpBar.style.top = Math.round(Math.max(130, H * 0.16) + 60) + 'px';
    }
    if (elFpChase) {
      elFpChase.classList.toggle('voy-seg__btn--on', !fpMode);
      elFpChase.setAttribute('aria-pressed', fpMode ? 'false' : 'true');
    }
    if (elFpCockpit) {
      elFpCockpit.classList.toggle('voy-seg__btn--on', fpMode);
      elFpCockpit.setAttribute('aria-pressed', fpMode ? 'true' : 'false');
    }
  }
  function setFpMode(on) {
    fpMode = !!on && !reduced;
    try { if (window.sessionStorage) sessionStorage.setItem(FP_KEY, fpMode ? '1' : '0'); } catch (e8) {}
    syncFpBar();
    setStatus(fpMode ? 'Cockpit view. The sky is drawn as relativity says you would see it.'
                     : 'Chase view.');
  }
  var elFpInfo = id('voy-fp-info');
  if (elFpChase) elFpChase.addEventListener('click', function () { setFpMode(false); });
  if (elFpCockpit) elFpCockpit.addEventListener('click', function () { setFpMode(true); });
  if (elFpInfo) elFpInfo.addEventListener('click', function () { replayCaptions(); });
  if (reduced && elFpBar) elFpBar.hidden = true;

  /* ---------------- porkchop-row buttons ---------------- */
  if (btnLaunch) btnLaunch.addEventListener('click', pcLaunch);
  if (btnNext) btnNext.addEventListener('click', nextWindow);
  if (btnBack) btnBack.addEventListener('click', exitPorkchop);

  /* ---------------- theme + resize wiring ---------------- */
  function onThemeChange() {
    pcDirty = true;
    atlas.dark = null; atlas.light = null;
    /* the galaxy cloud and the background tier are world-space points whose
       tint is picked per frame, so nothing there needs rebuilding */
    /* the PAINTED layers are theme-keyed pixels, so they do. invalidateTheme
       with no argument drops them and marks the bake stale; we then start it
       ourselves so the completion callback is ours and the frame governor
       gets its hold-off. The point cloud alone renders in the meantime,
       which is the same fallback as the first load. */
    if (galBakeTried) {
      var G = GAL();
      if (G && G.invalidateTheme) {
        try { G.invalidateTheme(); } catch (e) { /* enhancement only */ }
        startGalaxyBake();
      }
    }
  }
  if (window.MutationObserver) {
    new MutationObserver(onThemeChange).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange);
  }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      var oldPp = mode !== 'porkchop' && mode !== 'cruise';
      resize();
      layout();
      if (oldPp && !camAnim) { var pp = explorePP(); cam.ppx = pp.x; cam.ppy = pp.y; }
      pcCache = null; pcDirty = true;
      syncFpBar();
    }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else start();
  });

  /* ---------------- init ---------------- */
  try {
    var chk = A.verifyEphemerides();
    var chk2 = A.verifyRelativity();
    if (verifyEl) {
      var ok = chk.ok && chk2.ok;
      verifyEl.textContent = ok ? '✓ physics verified'
        : 'self-check failed, numbers may be off';
      verifyEl.title = 'Earth-Mars distance on 6 Oct 2020: ' + chk.dist2020.toFixed(4) +
        ' AU (published: 0.4149). Proxima at 1 g: ' + chk2.shipYears.toFixed(2) +
        ' ship years (expected 3.54).';
      if (!ok) verifyEl.classList.add('voy-verify--warn');
    }
  } catch (err) {
    if (verifyEl) verifyEl.textContent = 'self-check failed, numbers may be off';
  }
  if (!SD && statusEl) setStatus('Star catalog failed to load; planets still work.');

  resize();
  layout();

  if (window.GadgetUI) {
    var hint = GadgetUI.firstRunHint('voyage',
      'Tap any planet or star, or search for one, and plan the trip.');
    var pnl = GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'voy-panel--collapsed',
      help: elHelp, hint: hint,
      onToggle: function (c) {
        panelOpen = !c;
        if (L) { layout(); pcCache = null; pcDirty = true; }
      }
    });
    if (pnl && window.innerHeight < 520) pnl.setCollapsed(true);
    panelUi = pnl;
  }

  var restored = false;
  try { restored = restoreFromHash(); } catch (e3) { restored = false; }
  if (!restored) {
    if (reduced) skipIntroTo(6.3);
    else startIntro();
  }
  updatePanelMode();
  updateTargetLine();
  syncFpBar();

  /* the corner buttons + chat bar this layout measures are created after
     this deferred script runs; re-layout when they land */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { layout(); });
  }
  (function watchChat() {
    var done = false;
    function again() {
      if (done) return;
      done = true;
      layout();
    }
    if (document.getElementById('chat-widget')) { return; }
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (document.getElementById('chat-widget')) { mo.disconnect(); again(); }
      });
      mo.observe(document.body, { childList: true });
      setTimeout(function () { mo.disconnect(); }, 8000);
    }
    setTimeout(again, 2500);
  })();

  /* ---------------- test hooks ---------------- */
  var hooks = {
    PURE: PURE,
    starsCount: NS,
    bgCount: function () { return BG ? BG.n : 0; },
    bgLod: function () { return bgLod; },
    galaxyCount: function () { return galCloud ? galCloud.n : 0; },
    cruisePhase: function () {
      if (mode !== 'cruise' || !cruiseSt || !cruiseSt.ph) return null;
      return cruiseSt.ph.phase;
    },
    cruiseBeta: function () {
      return (cruiseSt && cruiseSt.cp) ? cruiseSt.cp.v : 0;
    },
    fpMode: function () { return fpMode; },
    setFpMode: function (v) { setFpMode(v); },
    fpCounts: function () {
      return { front: fpFront, back: fpBack, behind: fpBehind, red: fpRed };
    },
    shipAt: function () { return { kind: shipAt.kind, idx: shipAt.idx, label: shipLabel() }; },
    shipKey: function () { return shipKeyOf(accelIdx); },
    hudLines: function () {
      return (cruiseSt && cruiseSt.cp) ? cruiseHudLines(cruiseSt) : null;
    },
    hudBoxes: function () { return hudDrawn.slice(); },
    /* ---- wave 4, builder B ---- */
    cruisePose: function (tSec) {
      if (!cruiseSt) return null;
      var t = (typeof tSec === 'number' && isFinite(tSec))
        ? tSec : (performance.now() - cruiseSt.t0) / 1000;
      return PURE.cruisePose(t, cruisePlanOf(cruiseSt));
    },
    rig: function () {
      return { rigD: rigD, lookYaw: lookYaw, lookPitch: lookPitch,
               shipX: RIG.x, shipY: RIG.y, shipPx: RIG.px,
               shipYaw: RIG.yaw, shipAng: RIG.sang, shipBank: RIG.bank,
               ok: RIG.ok };
    },
    setLook: function (y, p) {
      lookYaw = clampN((typeof y === 'number' && isFinite(y)) ? y : 0, -Math.PI, Math.PI);
      lookPitch = clampN((typeof p === 'number' && isFinite(p)) ? p : 0,
                         -Math.PI * 0.45, Math.PI * 0.45);
    },
    setRigD: function (d) {
      rigD = clampN((typeof d === 'number' && isFinite(d)) ? d : 1, RIG_D_MIN, RIG_D_MAX);
    },
    /* the aberrated WORLD directions of the first n catalog stars at the
       live beta. Nothing here reads the view, which is the point: a 2 pi
       sweep of the look offsets must not move a single one of them. */
    abProbe: function (n) {
      var c = cruiseSt;
      if (!c || !c.cp || !SD) return null;
      var lim = Math.min(NS, (n | 0) || 200);
      var beta = clampN(c.cp.v, 0, 0.9999999);
      var out = [], fwd = 0, i, d = { x: 0, y: 0, z: 0, cos: 0, delta: 1 };
      for (i = 0; i < lim; i++) {
        PURE.aberrateDir(c.ux, c.uy, c.uz,
                         starX[i] - c.sx, starY[i] - c.sy, starZ[i] - c.sz, beta, d);
        out.push([d.x, d.y, d.z]);
        if (d.cos > 0) fwd++;
      }
      return { dirs: out, forward: fwd, beta: beta };
    },
    lookBack: function () {
      return { on: LB.on, x: LB.x, y: LB.y, r: LB.r, alpha: LB.alpha,
               sprite: LB.sprite, dLy: LB.dLy, name: LB.name, faint: LB.faint };
    },
    caption: function () { return capCur ? capCur.text : null; },
    captionSr: function () { return elCapSr ? elCapSr.textContent : null; },
    captionTrack: function () { return capTrack.slice(); },
    replayCaptions: function () { replayCaptions(); },
    artReady: !!ART,
    shipsReady: !!SHIPS,
    /* ---- wave 4 ---- */
    gl: function () {
      var G = GL();
      var info = (G && G.info) ? G.info() : null;
      if (!info) {
        return { supported: false, active: false,
                 reason: glOff ? 'disabled' : 'absent',
                 octaves: 0, targetPx: 0, blits: 0 };
      }
      return info;
    },
    glDisable: function () {
      glOff = true;
      var G = window.VoyageGL || null;
      if (G && G.disable) { try { G.disable(); } catch (e) { /* already gone */ } }
    },
    glReady: function () {
      var G = GL();
      return !!(G && G.info && G.info().active);
    },
    galaxyReady: function () {
      var G = GAL();
      return !!(G && G.ready && G.ready());
    },
    galaxyStats: function () {
      var G = GAL();
      return (G && G.stats) ? G.stats() : null;
    },
    orbBlend: function () { return lastOrbBlend; },
    starSpriteDraws: function () { return starSprites; },
    lod: function () {
      return { bgLod: bgLod, galStride: galStride, galLod: galLod,
               cruiseLod: cruiseLod };
    },
    /* TEST ONLY. The painted galaxy layers are the one demotion the
       governor is allowed to take back, which means a perf harness can
       never reproduce a given level on purpose and the per-layer budgets
       stayed unmeasured through the wave-4 review. This forces it; nothing
       in the page calls it. */
    /* TEST ONLY, same reason: pin the cruise step so a harness can measure
       or screenshot a chosen level (and prove level 0 is what an unloaded
       machine actually draws). Pinning also freezes the governor until the
       next launch. Nothing in the page calls it. */
    setCruiseLod: function (n) {
      n = Math.round(typeof n === 'number' && isFinite(n) ? n : 0);
      cruiseLod = n < 0 ? 0 : (n > 3 ? 3 : n);
      clHold = 1e9;
      return cruiseLod;
    },
    setGalLod: function (n) {
      n = Math.round(typeof n === 'number' && isFinite(n) ? n : 0);
      galLod = n < 0 ? 0 : (n > 2 ? 2 : n);
      galGood = 0;
      galKey = '';                       /* force the next draw to re-place */
      return galLod;
    },
    /* Every backing store the page owns, in bytes. The VoyageArt strip cache
       is reported at its worst case (a 512x256 texture plus an equal-sized
       aux layer per entry) because the library does not publish sizes. */
    mem: function () {
      var n = 0, k;
      if (canvas) n += (canvas.width || 0) * (canvas.height || 0) * 4;
      for (k in atlas) {
        if (atlas[k]) n += atlas[k].width * atlas[k].height * 4;
      }
      if (previews) {
        var pk, p;
        for (pk in previews) {
          p = previews[pk];
          if (p && p.cv) n += (p.cv.width || 0) * (p.cv.height || 0) * 4;
        }
      }
      var G = GL();
      if (G && G.memBytes) n += G.memBytes() | 0;
      var Q = GAL();
      if (Q && Q.stats) {
        var s = Q.stats();
        if (s && isFinite(s.bytes)) n += s.bytes;
      }
      if (ART && ART.texCacheSize) n += ART.texCacheSize() * 512 * 256 * 4 * 2;
      return n;
    },
    project: function (name) {
      updateCamBasis();
      var ln = String(name).toLowerCase();
      var P = { x: 0, y: 0, z: 0 };
      if (ln === 'sun') return projectPt(0, 0, 0, P) ? { x: P.x, y: P.y } : null;
      for (var q = 0; q < PLANET_LABELS.length; q++) {
        if (PLANET_LABELS[q].toLowerCase() === ln) {
          var st = A.planetState(PLANET_KEYS[q], viewJD);
          return projectPt(st.r[0], st.r[1], st.r[2], P) ? { x: P.x, y: P.y } : null;
        }
      }
      var i = starIndexByName(name);
      if (i < 0) return null;
      return projectPt(starX[i], starY[i], starZ[i], P) ? { x: P.x, y: P.y } : null;
    }
  };
  function rectOf(elm) {
    if (!elm || elm.hidden) return null;
    var r = elm.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  Object.defineProperties(hooks, {
    mode: { get: function () { return mode; } },
    selName: { get: function () { return sel ? bodyLabel(sel) : null; } },
    selExoName: { get: function () { return selExo >= 0 && SD ? SD.planets.name[selExo] : null; } },
    cam: { get: function () {
      var b = cam.basis;
      return { yaw: cam.yaw, pitch: cam.pitch, logD: cam.logD,
               center: [cam.cx, cam.cy, cam.cz],
               basis: b ? { fX: b.fX, fY: b.fY, fZ: b.fZ,
                            rX: b.rX, rY: b.rY, rZ: b.rZ,
                            uX: b.uX, uY: b.uY, uZ: b.uZ } : null };
    } },
    boxes: { get: function () {
      return {
        card: rectOf(cardEl),
        panel: rectOf(elPanel),
        plot: (L && mode === 'porkchop') ? L.plot : null,
        tl: (L && mode === 'porkchop') ? L.tl : null,
        ro: (L && mode === 'porkchop') ? L.ro : null,
        scalebar: sbRect,
        W: W, H: H
      };
    } }
  });
  window.__voy = hooks;

  start();
})();

/* ==========================================================================
   FAN-junH-shang — viewfinder
   Dependency-free port of the "drafting-table cursor" interaction frame.

   WHAT IT DOES
     - two hairlines cross the viewport through a smoothed pointer, broken by a
       10px gap so the pointer itself is never obscured;
     - the hairline brightens where it crosses the pointer and fades to 8% at
       the edges — light falls off, it does not stop;
     - a coordinate tag rides each axis, so the pointer position is always
       legible in mono numerals;
     - whatever actionable element is under the pointer (or holds
       :focus-visible) gets four right-angle brackets snapped around it, plus a
       "W x H" size tag — the drafting-table target lock;
     - a ring pulses outward on click;
     - brackets SNAP to a new target while only their ALPHA eases. Chasing a
       target from the previous one looks laggy; snapping reads as precise;
     - the rAF loop stops as soon as everything has settled. This runs on every
       pointer move, so an always-on loop is not acceptable.

   USE
     <canvas class="viewfinder" aria-hidden="true"></canvas>
     <script src="viewfinder.js"></script>
     // or: const destroy = viewfinder({ color: '#8aa2c4', targetSelector: '...' })

   ACCESSIBILITY
     The canvas is aria-hidden and never receives events. Because the brackets
     are the ONLY focus indicator for functional controls, they must be driven
     by :focus-visible as well as by the pointer — dropping the focus path
     leaves the app keyboard-invisible.
   ========================================================================== */

(function () {
  'use strict';

  function viewfinder(options) {
    var opts = options || {};
    var canvas =
      opts.canvas ||
      document.querySelector('canvas.viewfinder') ||
      (function () {
        var el = document.createElement('canvas');
        el.className = 'viewfinder';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
        return el;
      })();

    var ctx = canvas.getContext('2d');
    if (!ctx) return function () {};

    var FONT = '500 10px "JetBrains Mono Variable", ui-monospace, monospace';
    var thickness = opts.thickness != null ? opts.thickness : 1;
    var opacity = opts.opacity != null ? opts.opacity : 0.6;
    var gap = opts.gap != null ? opts.gap : 10;
    var smoothing = opts.smoothing != null ? opts.smoothing : 0.4;
    var showCoordinates = opts.showCoordinates !== false;
    var clickPulse = opts.clickPulse !== false;
    var targetSelector =
      opts.targetSelector ||
      'a, button, [role="button"], [role="radio"], [role="option"], [role="switch"], ' +
        '[role="checkbox"], [role="slider"], [data-crosshair-target], ' +
        '.select-card, .pick-row, .stat-tile, .data-table tbody tr';

    var reduce =
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

    var color =
      opts.color ||
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() ||
      '#8aa2c4';

    var state = {
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      clientX: 0,
      clientY: 0,
      inside: false,
      seen: false,
      presence: 0,
      target: null,
      focusTarget: null,
      lock: { x: 0, y: 0, w: 0, h: 0, alpha: 0 }
    };
    var pulses = [];
    var size = { w: 0, h: 0, dpr: 1 };
    var ink = toRgb(ctx, color);
    var raf = 0;
    var last = 0;
    var alive = true;
    var lockedEl = null;

    /* ------------------------------------------------------------ utils -- */

    function toRgb(c, value) {
      c.fillStyle = '#000';
      c.fillStyle = value;
      var v = String(c.fillStyle);
      if (v.charAt(0) === '#') {
        var hex = parseInt(v.slice(1, 7), 16);
        return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255, a: 1 };
      }
      var parts = (v.match(/[\d.]+/g) || [255, 255, 255, 1]).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] == null ? 1 : parts[3] };
    }

    function clamp(v, min, max) {
      return Math.min(max, Math.max(min, v));
    }

    function rgba(alpha) {
      return 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + clamp(alpha * ink.a, 0, 1) + ')';
    }

    /* Snap a coordinate to a half-pixel so a 1px line is exactly 1px on a
       retina panel instead of a 2px smear. */
    function crisp(value, width) {
      var device = Math.round(width * size.dpr);
      return (Math.round(value * size.dpr) + (device % 2 ? 0.5 : 0)) / size.dpr;
    }

    /* --------------------------------------------------------- painting -- */

    function tag(text, x, y, align) {
      ctx.font = FONT;
      var w = ctx.measureText(text).width + 10;
      var h = 16;
      var left = clamp(align === 'center' ? x - w / 2 : x, 4, size.w - w - 4);
      var top = clamp(align === 'middle' ? y - h / 2 : y, 4, size.h - h - 4);
      var light = ink.r * 0.2126 + ink.g * 0.7152 + ink.b * 0.0722 > 150;
      ctx.fillStyle = rgba(0.92);
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 3);
      ctx.fill();
      ctx.fillStyle = light ? '#0a0a0a' : '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(text, left + w / 2, top + h / 2 + 0.5);
    }

    function segment(x1, y1, x2, y2, horizontal) {
      var length = horizontal ? x2 - x1 : y2 - y1;
      if (length <= 0) return;
      var g = horizontal
        ? ctx.createLinearGradient(0, 0, size.w, 0)
        : ctx.createLinearGradient(0, 0, 0, size.h);
      var at = clamp(horizontal ? state.x / size.w : state.y / size.h, 0.001, 0.999);
      g.addColorStop(0, rgba(0.08));
      g.addColorStop(at, rgba(1));
      g.addColorStop(1, rgba(0.08));
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    function brackets(x, y, w, h, alpha) {
      /* The arm is a third of the shortest side, capped at 13px: a bracket must
         never be longer than the thing it frames. */
      var arm = Math.min(13, w / 3, h / 3);
      ctx.strokeStyle = rgba(alpha);
      ctx.lineWidth = Math.max(1.5, thickness);
      ctx.setLineDash([]);
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(x, y + arm);
      ctx.lineTo(x, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x + w - arm, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + arm);
      ctx.moveTo(x + w, y + h - arm);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w - arm, y + h);
      ctx.moveTo(x + arm, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + h - arm);
      ctx.stroke();
    }

    function draw() {
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      if (state.presence > 0.001) {
        /* The crosshair dims to 40% while a target is locked: two equally
           bright frames fight each other. */
        ctx.globalAlpha = state.presence * opacity * (1 - 0.6 * state.lock.alpha);
        ctx.lineWidth = thickness;
        ctx.lineCap = 'butt';
        ctx.setLineDash([]);
        var x = crisp(state.x, thickness);
        var y = crisp(state.y, thickness);
        segment(0, y, x - gap, y, true);
        segment(x + gap, y, size.w, y, true);
        segment(x, 0, x, y - gap, false);
        segment(x, y + gap, x, size.h, false);
        if (showCoordinates && state.lock.alpha < 0.999) {
          ctx.globalAlpha = state.presence * opacity * (1 - state.lock.alpha);
          tag(String(Math.round(state.x)), state.x, 10, 'center');
          tag(String(Math.round(state.y)), 10, state.y, 'middle');
        }
      }

      if (state.lock.alpha > 0.001) {
        var L = state.lock;
        ctx.globalAlpha = L.alpha * opacity;
        brackets(L.x, L.y, L.w, L.h, 1);
        if (showCoordinates && state.target) {
          var box = state.target.getBoundingClientRect();
          tag(
            Math.round(box.width) + ' \u00d7 ' + Math.round(box.height),
            L.x + L.w / 2,
            L.y + L.h + 10,
            'center'
          );
        }
      }

      for (var i = 0; i < pulses.length; i++) {
        var p = pulses[i];
        var t = p.age / 0.55;
        var eased = 1 - Math.pow(1 - t, 3);
        ctx.globalAlpha = Math.pow(1 - t, 2) * opacity;
        ctx.strokeStyle = rgba(1);
        ctx.lineWidth = Math.max(1, thickness);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + 30 * eased, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* ------------------------------------------------------------ frame -- */

    function relative() {
      var rect = canvas.getBoundingClientRect();
      state.tx = state.clientX - rect.left;
      state.ty = state.clientY - rect.top;
      return rect;
    }

    function tick(now) {
      raf = 0;
      if (!alive) return;
      var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      var rect = relative();

      var follow = reduce || smoothing === 0 ? 1 : 1 - Math.exp(-dt / (0.008 + smoothing * 0.16));
      state.x += (state.tx - state.x) * follow;
      state.y += (state.ty - state.y) * follow;
      var wanted = state.inside ? 1 : 0;
      state.presence +=
        (wanted - state.presence) * (reduce ? 1 : 1 - Math.exp(-dt / (wanted ? 0.12 : 0.25)));
      if (Math.abs(wanted - state.presence) < 0.002) state.presence = wanted;

      if (state.focusTarget && !state.focusTarget.isConnected) state.focusTarget = null;
      var lock = state.lock;
      var locked = state.target || state.focusTarget;

      /* A NEW target is snapped, never chased. Only alpha eases. */
      if (locked !== lockedEl) {
        lockedEl = locked;
        if (locked) {
          var box = locked.getBoundingClientRect();
          lock.x = box.left - rect.left - 6;
          lock.y = box.top - rect.top - 6;
          lock.w = box.width + 12;
          lock.h = box.height + 12;
        }
      }

      var goal;
      if (locked) {
        var b = locked.getBoundingClientRect();
        goal = { x: b.left - rect.left - 6, y: b.top - rect.top - 6, w: b.width + 12, h: b.height + 12 };
      } else {
        goal = { x: state.x - 10, y: state.y - 10, w: 20, h: 20 };
      }

      var snap = reduce ? 1 : 1 - Math.exp(-dt / 0.085);
      lock.x += (goal.x - lock.x) * snap;
      lock.y += (goal.y - lock.y) * snap;
      lock.w += (goal.w - lock.w) * snap;
      lock.h += (goal.h - lock.h) * snap;
      var shown = locked ? 1 : 0;
      lock.alpha += (shown - lock.alpha) * (reduce ? 1 : 1 - Math.exp(-dt / (shown ? 0.08 : 0.14)));
      if (Math.abs(shown - lock.alpha) < 0.002) lock.alpha = shown;

      for (var i = pulses.length - 1; i >= 0; i--) {
        pulses[i].age += dt;
        if (pulses[i].age >= 0.55) pulses.splice(i, 1);
      }
      draw();

      var settling =
        Math.abs(state.tx - state.x) > 0.05 ||
        Math.abs(state.ty - state.y) > 0.05 ||
        state.presence !== wanted ||
        lock.alpha !== shown ||
        (locked &&
          Math.abs(goal.w - lock.w) + Math.abs(goal.x - lock.x) + Math.abs(goal.y - lock.y) > 0.1) ||
        pulses.length > 0;

      /* On-demand rendering: no work while nothing moves. */
      if (settling) raf = requestAnimationFrame(tick);
    }

    function wake() {
      if (!raf && alive) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }

    function pick(el) {
      if (!(el instanceof Element)) return null;
      try {
        return el.closest(targetSelector);
      } catch (e) {
        return null;
      }
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      size.dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.w = rect.width;
      size.h = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * size.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * size.dpr));
      wake();
    }

    /* ----------------------------------------------------------- events -- */

    function enter() {
      if (!state.seen) {
        state.seen = true;
        relative();
        state.x = state.tx;
        state.y = state.ty;
        state.lock.x = state.x - 10;
        state.lock.y = state.y - 10;
        state.lock.w = 20;
        state.lock.h = 20;
      }
      state.inside = true;
    }

    function onMove(e) {
      state.clientX = e.clientX;
      state.clientY = e.clientY;
      if (e.pointerType === 'touch' && e.buttons === 0) return;
      enter();
      var next = pick(e.target);
      if (next !== state.target) state.target = next;
      wake();
    }

    function onDown(e) {
      onMove(e);
      if (!clickPulse || reduce) return;
      relative();
      pulses.push({ x: state.tx, y: state.ty, age: 0 });
      wake();
    }

    function onUp(e) {
      if (e.pointerType !== 'mouse') state.inside = false;
      wake();
    }

    function onLeave() {
      state.inside = false;
      state.target = null;
      wake();
    }

    /* Only :focus-visible draws brackets, so a mouse click keeps the pointer
       frame as the single frame. */
    function onFocusIn(e) {
      var found = pick(e.target);
      if (!found || !found.matches(':focus-visible')) return;
      state.focusTarget = found;
      wake();
    }

    function onFocusOut(e) {
      if (state.focusTarget && e.relatedTarget instanceof Node && state.focusTarget.contains(e.relatedTarget))
        return;
      state.focusTarget = null;
      wake();
    }

    var observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', resize);
    resize();

    function destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', resize);
      ctx.clearRect(0, 0, size.w, size.h);
    }

    return destroy;
  }

  if (typeof window !== 'undefined') {
    window.viewfinder = viewfinder;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        window.__viewfinderDestroy = viewfinder();
      });
    } else {
      window.__viewfinderDestroy = viewfinder();
    }
  }
})();

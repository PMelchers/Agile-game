'use strict';

// Behaviour monitors: per-car radar and telemetry, plus fleet-wide outcome charts.

function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, W: r.width, H: r.height };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// Outcome categories, in fixed palette order (validated for CVD on the dark surface).
const OUTCOMES = [
  { key: 'finished', label: 'Finished',        color: '--o-finished' },
  { key: 'wall',     label: 'Hit barrier',     color: '--o-wall' },
  { key: 'obstacle', label: 'Hit obstacle',    color: '--o-obstacle' },
  { key: 'ped',      label: 'Hit pedestrian',  color: '--o-ped' },
  { key: 'car',      label: 'Hit car',         color: '--o-car' },
  { key: 'other',    label: 'Stalled / timeout / wrong way', color: '--o-other' },
];

const _outcomeColors = {};
function outcomeColor(key) {
  if (!_outcomeColors[key]) {
    const o = OUTCOMES.find(x => x.key === key) || OUTCOMES[OUTCOMES.length - 1];
    _outcomeColors[key] = cssVar(o.color) || '#e66767';
  }
  return _outcomeColors[key];
}

// ---------------------------------------------------------------------------
// Minimap: the whole track, every car, and a coloured ✕ wherever a car failed
// (this generation bright, the previous one faded). Hover a ✕ for details,
// click a car or ✕ to watch that car.
// ---------------------------------------------------------------------------
class Minimap {
  constructor(canvas, tip, onPick) {
    this.canvas = canvas;
    this.tip = tip;
    this.onPick = onPick;
    this.track = null;
    this.hover = null;
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; });
    canvas.addEventListener('pointerdown', e => {
      const r = canvas.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit && this.onPick) this.onPick(hit);
      e.stopPropagation();
    });
  }

  layout(track, maxW, maxH) {
    const b = track.bounds, pad = 8;
    const s = Math.min((maxW - 2 * pad) / (b.maxX - b.minX), (maxH - 2 * pad) / (b.maxY - b.minY));
    const W = Math.round((b.maxX - b.minX) * s + 2 * pad), H = Math.round((b.maxY - b.minY) * s + 2 * pad);
    this.s = s; this.ox = pad - b.minX * s; this.oy = pad - b.minY * s;
    this.W = W; this.H = H;
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    this.dpr = dpr;
    // Cache the road so each frame only draws the moving parts.
    const bg = document.createElement('canvas');
    bg.width = this.canvas.width; bg.height = this.canvas.height;
    const g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = 'rgba(14,18,23,0.86)';
    g.fillRect(0, 0, W, H);
    g.lineJoin = 'round';
    g.strokeStyle = '#555a63';
    g.lineWidth = Math.max(3, track.width * s);
    g.beginPath();
    for (let i = 0; i <= track.N; i++) {
      const k = i % track.N, x = track.x[k] * s + this.ox, y = track.y[k] * s + this.oy;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const sx = track.x[0] * s + this.ox, sy = track.y[0] * s + this.oy;
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(sx - track.nx[0] * (track.hw * s + 3), sy - track.ny[0] * (track.hw * s + 3));
    g.lineTo(sx + track.nx[0] * (track.hw * s + 3), sy + track.ny[0] * (track.hw * s + 3));
    g.stroke();
    this.bg = bg;
    this.track = track;
    this.maxW = maxW; this.maxH = maxH;
  }

  toMap(x, y) { return { x: x * this.s + this.ox, y: y * this.s + this.oy }; }

  hitTest(mx, my) {
    let best = null, bd = 9 * 9;
    for (const m of this.sim.crashMarks) {
      const p = this.toMap(m.x, m.y), d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bd) { bd = d; best = { mark: m }; }
    }
    for (const m of this.sim.prevCrashMarks) {
      const p = this.toMap(m.x, m.y), d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bd * 0.8) { bd = d; best = { mark: m }; }
    }
    for (const c of this.sim.cars) {
      if (!c.alive) continue;
      const p = this.toMap(c.x, c.y), d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bd) { bd = d; best = { car: c }; }
    }
    return best;
  }

  draw(sim, renderer, focus, maxW, maxH) {
    this.sim = sim;
    if (this.track !== sim.track || this.maxW !== maxW || this.maxH !== maxH) this.layout(sim.track, maxW, maxH);
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    for (const o of sim.obstacles) {
      const p = this.toMap(o.x, o.y);
      ctx.fillStyle = o.type === 'cone' ? '#f07c1e' : o.type === 'ped' ? '#ffd23f' : o.type === 'rock' ? '#9a9ca3' : '#c9ced8';
      ctx.fillRect(p.x - 1.2, p.y - 1.2, 2.4, 2.4);
    }

    // Main camera's view as a frame
    if (renderer.mode === 'follow') {
      const z = renderer.cam.zoom;
      const a = this.toMap(renderer.cam.x - renderer.w / 2 / z, renderer.cam.y - renderer.h / 2 / z);
      const b = this.toMap(renderer.cam.x + renderer.w / 2 / z, renderer.cam.y + renderer.h / 2 / z);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    }

    const cross = (marks, alpha, size) => {
      ctx.globalAlpha = alpha; ctx.lineWidth = 1.6;
      for (const o of OUTCOMES) {
        ctx.strokeStyle = outcomeColor(o.key);
        ctx.beginPath();
        for (const m of marks) {
          if (m.key !== o.key) continue;
          const p = this.toMap(m.x, m.y);
          ctx.moveTo(p.x - size, p.y - size); ctx.lineTo(p.x + size, p.y + size);
          ctx.moveTo(p.x + size, p.y - size); ctx.lineTo(p.x - size, p.y + size);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    cross(sim.prevCrashMarks, 0.3, 2);
    cross(sim.crashMarks, 1, 3);

    ctx.fillStyle = 'rgba(120,190,255,0.9)';
    for (const c of sim.cars) {
      if (!c.alive) continue;
      const p = this.toMap(c.x, c.y);
      ctx.fillRect(p.x - 1.3, p.y - 1.3, 2.6, 2.6);
    }
    if (focus) {
      const p = this.toMap(focus.x, focus.y);
      ctx.fillStyle = focus.alive || focus.status === 'finished' ? '#35d0ff' : '#e66767';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, TAU); ctx.fill(); ctx.stroke();
    }

    // Hover details
    const hit = this.hover && this.hitTest(this.hover.x, this.hover.y);
    if (!hit) { this.tip.hidden = true; return; }
    let html, at;
    if (hit.mark) {
      const m = hit.mark;
      at = this.toMap(m.x, m.y);
      const when = m.gen === sim.generation ? 'this generation' : `generation ${m.gen}`;
      html = `<b>Car ${m.car}</b> · ${when}<br><span class="dot" style="background:${outcomeColor(m.key)}"></span>${escapeHtml(m.cause)}<br>${m.pct.toFixed(0)}% of the lap · after ${m.t.toFixed(1)}s` +
        (m.gen === sim.generation ? '<br><i>Click to watch this car</i>' : '');
    } else {
      const c = hit.car;
      at = this.toMap(c.x, c.y);
      html = `<b>Car ${c.id}</b> · driving<br>${Math.round(c.speed)} px/s · ${(clamp((c.maxProgress - START_IDX) / (sim.track.N * sim.params.laps), 0, 1) * 100).toFixed(0)}% of the lap<br><i>Click to watch this car</i>`;
    }
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(at.x, at.y, 6, 0, TAU); ctx.stroke();
    this.tip.hidden = false;
    this.tip.innerHTML = html;
    // The map sits at the right edge of the screen, so tooltips open to its left.
    this.tip.style.left = (at.x - this.tip.offsetWidth - 10) + 'px';
    this.tip.style.top = Math.max(0, at.y - 12) + 'px';
  }
}

// ---------------------------------------------------------------------------
// Sensor radar: the car sits at the bottom centre, nose up; each ray is drawn
// to scale and the free space it sees is shaded.
// ---------------------------------------------------------------------------
function drawRadar(canvas, car, range) {
  const { ctx, W, H } = fitCanvas(canvas);
  if (!car) return;
  const cx = W / 2, cy = H - 16, R = Math.min(W / 2 - 10, H - 30);
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  for (const f of [0.33, 0.66, 1]) {
    ctx.beginPath(); ctx.arc(cx, cy, R * f, Math.PI, TAU); ctx.stroke();
  }
  ctx.fillStyle = cssVar('--text-muted');
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(range)}px`, cx + R * 0.72, cy - R * 0.72);

  const pts = RAY_ANGLES.map((a, r) => {
    const d = Math.min(car.rayLen[r], range) / range * R;
    const ang = a - Math.PI / 2;
    return { x: cx + Math.cos(ang) * d, y: cy + Math.sin(ang) * d, v: car.sensors[r], d: car.rayLen[r] };
  });
  ctx.fillStyle = 'rgba(53,208,255,0.12)';
  ctx.beginPath(); ctx.moveTo(cx, cy);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.closePath(); ctx.fill();
  for (const p of pts) {
    const col = `rgb(${Math.round(80 + 175 * p.v)},${Math.round(230 - 170 * p.v)},120)`;
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = '#35d0ff';
  roundRect(ctx, cx - 5, cy - 9, 10, 18, 3); ctx.fill();
}

// ---------------------------------------------------------------------------
// Telemetry strips: last 30 s of speed, steering, gas/brake and clearance,
// with one crosshair shared across all strips.
// ---------------------------------------------------------------------------
class Telemetry {
  constructor(canvas) {
    this.canvas = canvas;
    this.hoverX = null;
    canvas.addEventListener('pointermove', e => { this.hoverX = e.clientX - canvas.getBoundingClientRect().left; });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; });
  }

  draw(car, range) {
    const { ctx, W, H } = fitCanvas(this.canvas);
    if (!car) return;
    const strips = [
      { label: 'Speed', min: 0, max: MAX_SPEED, fmt: v => `${Math.round(v)} px/s`, ch: 0 },
      { label: 'Steering', min: -1, max: 1, zero: true, fmt: v => Math.abs(v) < 0.05 ? 'straight' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`, ch: 1 },
      { label: 'Gas / brake', min: -1, max: 1, zero: true, fmt: v => v >= 0 ? `gas ${Math.round(v * 100)}%` : `brake ${Math.round(-v * 100)}%`, ch: 2 },
      { label: 'Clearance', min: 0, max: range, danger: CLOSE_CALL + 12, fmt: v => `${Math.round(v)} px`, ch: 3 },
    ];
    const padL = 8, padR = 8, gap = 8, head = 14, axis = 14;
    const sh = (H - axis - gap * (strips.length - 1)) / strips.length;
    const pw = W - padL - padR;
    const n = Math.min(car.traceN, TRACE_LEN);
    const sample = (k, ch) => car.trace[((car.traceN - n + k) % TRACE_LEN) * TRACE_CH + ch];
    const xAt = k => padL + pw - ((n - 1 - k) / (TRACE_LEN - 1)) * pw;
    let hk = -1;
    if (this.hoverX != null && n > 0) {
      hk = clamp(Math.round(n - 1 - ((padL + pw - this.hoverX) / pw) * (TRACE_LEN - 1)), 0, n - 1);
    }
    const accent = cssVar('--accent'), muted = cssVar('--text-muted'), text = cssVar('--text'), grid = cssVar('--grid');
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';

    strips.forEach((s, si) => {
      const top = si * (sh + gap), y0 = top + head, h = sh - head;
      const yAt = v => y0 + h * (1 - (clamp(v, s.min, s.max) - s.min) / (s.max - s.min));
      ctx.fillStyle = cssVar('--surface');
      ctx.fillRect(padL, y0, pw, h);
      if (s.danger) {
        ctx.fillStyle = 'rgba(230,103,103,0.14)';
        ctx.fillRect(padL, yAt(s.danger), pw, y0 + h - yAt(s.danger));
      }
      if (s.zero) {
        ctx.strokeStyle = grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, Math.round(yAt(0)) + 0.5); ctx.lineTo(padL + pw, Math.round(yAt(0)) + 0.5); ctx.stroke();
      }
      if (n > 1) {
        ctx.strokeStyle = accent; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const x = xAt(k), y = yAt(sample(k, s.ch));
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      const k = hk >= 0 ? hk : n - 1;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillStyle = muted;
      ctx.fillText(s.label, padL, top);
      if (n > 0) {
        ctx.textAlign = 'right'; ctx.fillStyle = text;
        ctx.fillText(s.fmt(sample(k, s.ch)), padL + pw, top);
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(xAt(k), yAt(sample(k, s.ch)), 3, 0, TAU); ctx.fill();
      }
    });

    ctx.textBaseline = 'bottom'; ctx.fillStyle = muted;
    ctx.textAlign = 'left'; ctx.fillText('30s ago', padL, H);
    ctx.textAlign = 'right'; ctx.fillText(car.alive ? 'now' : 'end of run', padL + pw, H);
    if (hk >= 0) {
      const x = Math.round(xAt(hk)) + 0.5;
      ctx.strokeStyle = muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, head); ctx.lineTo(x, H - axis); ctx.stroke();
      const ago = (n - 1 - hk) * TRACE_EVERY / 60;
      ctx.textAlign = 'center'; ctx.fillStyle = text;
      ctx.fillText(ago < 0.05 ? 'latest' : `${ago.toFixed(1)}s earlier`, clamp(x, padL + 40, padL + pw - 40), H);
    }
  }
}

// ---------------------------------------------------------------------------
// How each generation ended: 100% stacked bars, one per generation.
// ---------------------------------------------------------------------------
class OutcomeChart {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.tip = tip;
    this.hover = null;
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left };
      this.draw(this.data);
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; this.draw(this.data); });
  }

  draw(history) {
    this.data = history;
    const { ctx, W, H } = fitCanvas(this.canvas);
    const data = history.filter(h => h.outcomes).slice(-40);
    const pad = { l: 30, r: 6, t: 6, b: 16 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = cssVar('--text-muted');
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0, 50, 100]) ctx.fillText(v + '%', pad.l - 5, pad.t + ph * (1 - v / 100));
    if (!data.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Finish a generation to see how runs end', pad.l + pw / 2, pad.t + ph / 2);
      this.tip.hidden = true;
      return;
    }
    const slot = pw / Math.max(data.length, 12);
    const bw = Math.max(3, slot - 2);                 // 2px surface gap between bars
    const colors = OUTCOMES.map(o => cssVar(o.color));
    const surface = cssVar('--surface-2');
    data.forEach((d, i) => {
      const x = pad.l + i * slot;
      let y = pad.t + ph;
      OUTCOMES.forEach((o, k) => {
        const hgt = (d.outcomes[o.key] / d.pop) * ph;
        if (hgt <= 0) return;
        ctx.fillStyle = colors[k];
        ctx.fillRect(x, y - hgt, bw, hgt);
        ctx.fillStyle = surface;                        // 1px separator between stacked segments
        ctx.fillRect(x, y - hgt, bw, Math.min(1, hgt));
        y -= hgt;
      });
    });
    ctx.textBaseline = 'bottom'; ctx.fillStyle = cssVar('--text-muted');
    ctx.textAlign = 'left'; ctx.fillText('gen ' + data[0].gen, pad.l, H);
    ctx.textAlign = 'right'; ctx.fillText('gen ' + data[data.length - 1].gen, pad.l + data.length * slot - 2, H);

    if (this.hover) {
      const i = Math.floor((this.hover.x - pad.l) / slot);
      if (i >= 0 && i < data.length) {
        const d = data[i];
        ctx.strokeStyle = cssVar('--text'); ctx.lineWidth = 1;
        ctx.strokeRect(pad.l + i * slot - 0.5, pad.t - 0.5, bw + 1, ph + 1);
        this.tip.hidden = false;
        this.tip.innerHTML = `<b>Generation ${d.gen}</b> · level ${d.level}<br>` +
          OUTCOMES.slice().reverse().map(o => {
            const c = d.outcomes[o.key];
            return c ? `<span class="dot" style="background:var(${o.color})"></span>${o.label} <b>${c}</b> (${Math.round(c / d.pop * 100)}%)` : '';
          }).filter(Boolean).join('<br>') +
          (d.safeWaits != null ? `<br>Safe waits for pedestrians or cars: <b>${d.safeWaits}</b>` : '');
        const tw = this.tip.offsetWidth;
        this.tip.style.left = clamp(pad.l + i * slot - tw / 2, 0, W - tw) + 'px';
        this.tip.style.top = '-6px';
        this.tip.style.transform = 'translateY(-100%)';
        return;
      }
    }
    this.tip.hidden = true;
  }
}

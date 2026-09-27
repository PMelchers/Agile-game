'use strict';

// Draws the world: road, scenery, obstacles, cars, sensors and crash marks.
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.mode = 'follow';
    this.userZoom = 1;
    this.showSensors = true;
    this.track = null;
    this.dpr = 1;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.w = r.width; this.h = r.height;
  }

  setTrack(track, params) {
    this.track = track;
    this.params = params;
    const p = new Path2D();
    p.moveTo(track.x[0], track.y[0]);
    for (let i = 1; i < track.N; i++) p.lineTo(track.x[i], track.y[i]);
    p.closePath();
    this.roadPath = p;

    // Scatter trees on the grass, well clear of the road.
    const rand = mulberry32(track.seed ^ 0x5eed);
    const b = track.bounds, pad = 300;
    const trees = [];
    const clear2 = (track.hw + 26) ** 2;
    const count = Math.round(((b.maxX - b.minX + 2 * pad) * (b.maxY - b.minY + 2 * pad)) / 16000);
    for (let k = 0; k < count; k++) {
      const x = b.minX - pad + rand() * (b.maxX - b.minX + 2 * pad);
      const y = b.minY - pad + rand() * (b.maxY - b.minY + 2 * pad);
      let ok = true;
      for (let i = 0; i < track.N; i += 2) {
        const dx = x - track.x[i], dy = y - track.y[i];
        if (dx * dx + dy * dy < clear2) { ok = false; break; }
      }
      if (ok) trees.push({ x, y, r: 7 + rand() * 9, shade: rand() });
    }
    this.trees = trees;
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.cam.zoom + this.cam.x, y: (sy - this.h / 2) / this.cam.zoom + this.cam.y };
  }

  updateCamera(sim, dt, focus) {
    const tr = sim.track, b = tr.bounds;
    let tx, ty, tz;
    if (this.mode === 'overview') {
      tx = (b.minX + b.maxX) / 2; ty = (b.minY + b.maxY) / 2;
      tz = Math.min(this.w / (b.maxX - b.minX + 80), this.h / (b.maxY - b.minY + 80));
    } else {
      tx = focus ? focus.x : 0; ty = focus ? focus.y : 0;
      tz = clamp(Math.min(this.w, this.h) / 520, 0.6, 2.2);
    }
    tz *= this.userZoom;
    const k = 1 - Math.exp(-dt * 6);
    if (this.snap) { this.cam.x = tx; this.cam.y = ty; this.cam.zoom = tz; this.snap = false; }
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom += (tz - this.cam.zoom) * k;
  }

  // focus: the car being watched (picked by the viewer, or the leader).
  // ghost: preview of an obstacle about to be placed, or null.
  draw(sim, dt, focus, picked, ghost) {
    if (this.track !== sim.track) { this.setTrack(sim.track, sim.params); this.snap = true; }
    this.updateCamera(sim, dt, focus);
    const ctx = this.ctx, tr = sim.track, P = sim.params, z = this.cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = P.f.ice > 0 ? '#2d4a44' : '#2f5a2c';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(z, z);
    ctx.translate(-this.cam.x, -this.cam.y);

    const view = {
      x0: this.cam.x - this.w / 2 / z - 40, x1: this.cam.x + this.w / 2 / z + 40,
      y0: this.cam.y - this.h / 2 / z - 40, y1: this.cam.y + this.h / 2 / z + 40,
    };
    const inView = (x, y) => x > view.x0 && x < view.x1 && y > view.y0 && y < view.y1;

    // Trees
    for (const t of this.trees) {
      if (!inView(t.x, t.y)) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(t.x + 3, t.y + 3, t.r, 0, TAU); ctx.fill();
      ctx.fillStyle = t.shade > 0.5 ? '#24632a' : '#1d5423';
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, TAU); ctx.fill();
    }

    // Road: curb, asphalt, lane markings
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = '#e8e4da'; ctx.lineWidth = tr.width + 8; ctx.stroke(this.roadPath);
    ctx.strokeStyle = '#c0392b'; ctx.setLineDash([14, 14]); ctx.stroke(this.roadPath); ctx.setLineDash([]);
    ctx.strokeStyle = P.f.ice > 0 ? '#5a6b78' : '#44474d'; ctx.lineWidth = tr.width; ctx.stroke(this.roadPath);
    if (P.f.ice > 0) {
      ctx.strokeStyle = `rgba(200,230,255,${Math.min(0.25, 0.05 * P.f.ice)})`;
      ctx.lineWidth = tr.width * 0.6; ctx.stroke(this.roadPath);
    }
    ctx.strokeStyle = 'rgba(255,214,90,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([16, 18]);
    ctx.stroke(this.roadPath); ctx.setLineDash([]);

    // Start / finish line (checkered)
    {
      const i = 0, a = tr.ang[i];
      ctx.save();
      ctx.translate(tr.x[i], tr.y[i]);
      ctx.rotate(a);
      const cells = Math.max(4, Math.round(tr.width / 8)), cw = tr.width / cells;
      for (let k = 0; k < cells; k++) for (let r = 0; r < 2; r++) {
        ctx.fillStyle = (k + r) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(-6 + r * 6, -tr.hw + k * cw, 6, cw);
      }
      ctx.restore();
    }

    // Crash marks: this generation bright, the previous one faded
    this.drawCrashes(sim.prevCrashMarks, 0.25, view);
    this.drawCrashes(sim.crashMarks, 0.85, view);

    // Obstacles
    for (const o of sim.obstacles) {
      if (!inView(o.x, o.y)) continue;
      this.drawObstacle(o);
      if (o.custom) {          // hand-placed: dashed ring so it stands out
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    if (ghost) {
      ctx.globalAlpha = 0.55;
      if (ghost.kind === 'erase') {
        ctx.strokeStyle = ghost.ok ? '#ff6b6b' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ghost.x, ghost.y, 14, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ghost.x - 7, ghost.y - 7); ctx.lineTo(ghost.x + 7, ghost.y + 7);
        ctx.moveTo(ghost.x + 7, ghost.y - 7); ctx.lineTo(ghost.x - 7, ghost.y + 7); ctx.stroke();
      } else {
        this.drawObstacle(ghost.o);
        ctx.strokeStyle = ghost.ok ? '#3ecf8e' : '#ff6b6b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ghost.x, ghost.y, ghost.o.r + 5, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Cars: the crowd first, then the watched car on top with its sensors
    for (const c of sim.cars) {
      if (!c.alive || c === focus || !inView(c.x, c.y)) continue;
      this.drawCar(c, 'rgba(120,190,255,0.45)', null);
    }
    for (const c of sim.cars) {
      if (c.status !== 'finished' || c === focus || !inView(c.x, c.y)) continue;
      this.drawCar(c, 'rgba(90,230,150,0.5)', null);
    }
    if (focus) {
      if (this.showSensors && focus.alive) {
        for (let r = 0; r < NUM_RAYS; r++) {
          const a = focus.h + RAY_ANGLES[r], d = focus.rayLen[r];
          const v = focus.sensors[r];
          ctx.strokeStyle = `rgba(${Math.round(80 + 175 * v)},${Math.round(230 - 170 * v)},120,0.75)`;
          ctx.lineWidth = 1.2 / z * 1.5;
          ctx.beginPath(); ctx.moveTo(focus.x, focus.y);
          ctx.lineTo(focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d); ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath(); ctx.arc(focus.x + Math.cos(a) * d, focus.y + Math.sin(a) * d, 2.5, 0, TAU); ctx.fill();
        }
      }
      const fill = focus.alive || focus.status === 'finished' ? '#35d0ff' : '#e66767';
      this.drawCar(focus, fill, '#ffffff');
      if (picked) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 / z * 1.5; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(focus.x, focus.y, 20, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();

    // Fog: a mist that thickens beyond what the leader's sensors can see
    if (P.f.fog > 0 && focus) {
      const sx = (focus.x - this.cam.x) * z + this.w / 2, sy = (focus.y - this.cam.y) * z + this.h / 2;
      const rIn = P.sensorRange * z * 0.6, rOut = P.sensorRange * z * 1.6;
      const g = ctx.createRadialGradient(sx, sy, rIn, sx, sy, rOut);
      const a = Math.min(0.75, 0.12 * P.f.fog);
      g.addColorStop(0, 'rgba(210,215,222,0)');
      g.addColorStop(1, `rgba(210,215,222,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  drawObstacle(o, ctx = this.ctx) {
    if (o.type === 'cone') {
      ctx.fillStyle = '#f07c1e';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.55, 0, TAU); ctx.stroke();
    } else if (o.type === 'rock') {
      ctx.fillStyle = '#7d7f86';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#9a9ca3';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.25, o.y - o.r * 0.25, o.r * 0.55, 0, TAU); ctx.fill();
    } else if (o.type === 'ped') {
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6b3fa0';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.5, 0, TAU); ctx.fill();
    } else {
      ctx.save();
      ctx.translate(o.x, o.y); ctx.rotate(o.h || 0);
      ctx.fillStyle = o.type === 'parked' ? '#8a96a8' : `hsl(${o.hue},35%,62%)`;
      roundRect(ctx, -11, -6, 22, 12, 3); ctx.fill();
      ctx.fillStyle = 'rgba(20,30,40,0.7)'; ctx.fillRect(2, -4.5, 4, 9);
      ctx.fillStyle = o.type === 'parked' ? '#ffb020' : '#ffe9a8';     // parked cars show hazard lights
      ctx.fillRect(9, -5, 2, 3); ctx.fillRect(9, 2, 2, 3);
      if (o.type === 'parked') { ctx.fillRect(-11, -5, 2, 3); ctx.fillRect(-11, 2, 2, 3); }
      ctx.restore();
    }
  }

  drawCar(c, fill, outline) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(c.h);
    ctx.fillStyle = fill;
    roundRect(ctx, -CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W, 3); ctx.fill();
    if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.fillStyle = 'rgba(10,20,35,0.65)';
    ctx.fillRect(1, -CAR_W / 2 + 1.5, 4, CAR_W - 3);
    ctx.restore();
  }

  drawCrashes(marks, alpha, view) {
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(255,70,70,${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const m of marks) {
      if (m.x < view.x0 || m.x > view.x1 || m.y < view.y0 || m.y > view.y1) continue;
      ctx.moveTo(m.x - 4, m.y - 4); ctx.lineTo(m.x + 4, m.y + 4);
      ctx.moveTo(m.x + 4, m.y - 4); ctx.lineTo(m.x - 4, m.y + 4);
    }
    ctx.stroke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Safety-over-generations chart with a hover crosshair + tooltip.
// ---------------------------------------------------------------------------
class SafetyChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tip = tooltip;
    this.ctx = canvas.getContext('2d');
    this.hover = null;
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw(this.data, this.threshold);
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; this.draw(this.data, this.threshold); });
  }

  draw(history, threshold) {
    this.data = history; this.threshold = threshold;
    const c = this.canvas, ctx = this.ctx;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    }
    const W = r.width, H = r.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = n => css.getPropertyValue(n).trim();
    const pad = { l: 28, r: 8, t: 8, b: 18 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const data = history.slice(-150);

    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = col('--text-muted');
    ctx.strokeStyle = col('--grid');
    ctx.lineWidth = 1;
    for (const v of [0, 25, 50, 75, 100]) {
      const y = pad.t + ph * (1 - v / 100);
      ctx.beginPath(); ctx.moveTo(pad.l, y + 0.5); ctx.lineTo(W - pad.r, y + 0.5); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(String(v), pad.l - 5, y);
    }
    if (!data.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Finish a generation to see progress', pad.l + pw / 2, pad.t + ph / 2);
      this.tip.hidden = true;
      return;
    }
    const n = data.length;
    const xAt = i => pad.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const yAt = v => pad.t + ph * (1 - v / 100);

    // pass threshold
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = col('--text-muted');
    ctx.beginPath(); ctx.moveTo(pad.l, yAt(threshold) + 0.5); ctx.lineTo(W - pad.r, yAt(threshold) + 0.5); ctx.stroke();
    ctx.setLineDash([]);

    // level-up markers
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let lastLabelX = -Infinity;
    for (let i = 1; i < n; i++) {
      if (data[i].level !== data[i - 1].level) {
        const x = Math.round(xAt(i)) + 0.5;
        ctx.strokeStyle = col('--grid-strong');
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
        const label = 'L' + data[i].level;
        const lw = ctx.measureText(label).width;
        if (x - lastLabelX > lw + 6 && x + 2 + lw < W - pad.r) {   // skip labels that would collide
          ctx.fillStyle = col('--text-muted');
          ctx.fillText(label, x + 2, pad.t + 1);
          lastLabelX = x;
        }
      }
    }

    const line = (key, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      data.forEach((d, i) => (i ? ctx.lineTo(xAt(i), yAt(d[key])) : ctx.moveTo(xAt(i), yAt(d[key]))));
      ctx.stroke();
    };
    line('avg', col('--series-2'));
    line('best', col('--series-1'));

    ctx.fillStyle = col('--text-muted');
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('gen ' + data[0].gen, pad.l, H);
    ctx.textAlign = 'right';
    ctx.fillText('gen ' + data[n - 1].gen, W - pad.r, H);

    if (this.hover && this.hover.x >= pad.l - 4) {
      const i = clamp(Math.round(((this.hover.x - pad.l) / pw) * (n - 1)), 0, n - 1);
      const d = data[i], x = xAt(i);
      ctx.strokeStyle = col('--text-muted'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t); ctx.lineTo(x + 0.5, pad.t + ph); ctx.stroke();
      for (const [k, cvar] of [['best', '--series-1'], ['avg', '--series-2']]) {
        ctx.fillStyle = col(cvar); ctx.strokeStyle = col('--surface');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, yAt(d[k]), 4, 0, TAU); ctx.fill(); ctx.stroke();
      }
      this.tip.hidden = false;
      this.tip.innerHTML =
        `<b>Generation ${d.gen}</b> · level ${d.level}<br>` +
        `<span class="sw s1"></span>Best car <b>${d.best.toFixed(1)}</b><br>` +
        `<span class="sw s2"></span>Fleet avg <b>${d.avg.toFixed(1)}</b><br>` +
        `${d.finished}/${d.pop} finished · ${d.crashes} crashed`;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = clamp(x - tw / 2, 0, W - tw) + 'px';
      this.tip.style.top = '-6px';
      this.tip.style.transform = 'translateY(-100%)';
    } else {
      this.tip.hidden = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Live view of the leader's neural network.
// ---------------------------------------------------------------------------
const INPUT_LABELS = ['←90°', '←55°', '←30°', '←12°', 'ahead', '12°→', '30°→', '55°→', '90°→', 'speed', 'lane pos', 'heading', 'bend'];
function drawBrain(canvas, net) {
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  }
  const W = r.width, H = r.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!net) return;
  const sizes = net.sizes, L = sizes.length;
  const left = 58, right = 50;
  const pos = sizes.map((n, l) => {
    const x = left + (l / (L - 1)) * (W - left - right);
    return Array.from({ length: n }, (_, j) => ({ x, y: 10 + ((j + 0.5) / n) * (H - 20) }));
  });
  let o = 0;
  for (let l = 0; l < L - 1; l++) {
    for (let j = 0; j < sizes[l + 1]; j++) {
      for (let i = 0; i < sizes[l]; i++) {
        const w = net.w[o++];
        const act = Math.abs(net.acts[l][i]);
        const a = Math.min(0.9, Math.abs(w) * 0.18 * (0.25 + act));
        if (a < 0.04) continue;
        ctx.strokeStyle = w > 0 ? `rgba(80,200,255,${a})` : `rgba(255,120,90,${a})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pos[l][i].x, pos[l][i].y); ctx.lineTo(pos[l + 1][j].x, pos[l + 1][j].y); ctx.stroke();
      }
      o++; // bias
    }
  }
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  for (let l = 0; l < L; l++) {
    for (let j = 0; j < sizes[l]; j++) {
      const v = net.acts[l][j], p = pos[l][j];
      ctx.fillStyle = v >= 0 ? `rgba(80,200,255,${0.25 + 0.75 * Math.abs(v)})` : `rgba(255,120,90,${0.25 + 0.75 * Math.abs(v)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, l === 0 || l === L - 1 ? 4.5 : 3.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#9aa3b2';
      if (l === 0) { ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(INPUT_LABELS[j] || '', p.x - 8, p.y); }
      if (l === L - 1) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const label = j === 0 ? (v < -0.1 ? 'steer ←' : v > 0.1 ? 'steer →' : 'steer') : (v >= 0 ? 'gas' : 'brake');
        ctx.fillText(label, p.x + 8, p.y);
      }
    }
  }
}

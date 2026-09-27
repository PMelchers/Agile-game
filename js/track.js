'use strict';

const TRACK_SPACING = 10;   // px between centerline samples
const GRID_CELL = 80;       // px, spatial hash cell for wall segments

// Builds a closed, non-self-intersecting circuit from a seed.
// Control points sit around a (stretched) circle with random radial jitter,
// get smoothed with Catmull-Rom, resampled to even spacing, then validated
// for too-tight corners and parts of the road that come too close together.
function generateTrack(seed, opts) {
  let amp = opts.amplitude;
  for (let attempt = 0; attempt < 80; attempt++) {
    const rand = mulberry32((seed * 7919 + attempt * 104729 + 1) >>> 0);
    const t = tryBuildTrack(rand, opts.radius, amp, opts.nPoints, opts.width, false);
    if (t) { t.seed = seed; return t; }
    if (attempt % 4 === 3) amp *= 0.9;
  }
  const t = tryBuildTrack(() => 0.5, opts.radius, 0, 12, opts.width, true);
  t.seed = seed;
  return t;
}

function tryBuildTrack(rand, R, amp, n, width, force) {
  const stretch = 1 + rand() * 0.6;
  const mirror = rand() < 0.5 ? -1 : 1;
  const rot = rand() * TAU;
  const ctrl = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rand() - 0.5) * (TAU / n) * 0.5;
    const r = R * (1 + amp * (rand() * 2 - 1));
    const x = Math.cos(a) * r * stretch * mirror, y = Math.sin(a) * r;
    ctrl.push({ x: x * Math.cos(rot) - y * Math.sin(rot), y: x * Math.sin(rot) + y * Math.cos(rot) });
  }
  const dense = [];
  const SUB = 24;
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB, t2 = t * t, t3 = t2 * t;
      dense.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  const pts = resampleClosed(dense, TRACK_SPACING);
  if (!force && !validateTrack(pts, width)) return null;
  return buildTrack(pts, width);
}

function resampleClosed(pts, spacing) {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cum[n];
  const m = Math.max(16, Math.round(total / spacing));
  const out = [];
  let seg = 0;
  for (let k = 0; k < m; k++) {
    const s = (k / m) * total;
    while (cum[seg + 1] < s) seg++;
    const a = pts[seg], b = pts[(seg + 1) % n];
    const f = (s - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

function validateTrack(pts, width) {
  const N = pts.length, hw = width / 2;
  const minR = hw * 1.3 + 30;
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 3 + N) % N], b = pts[i], c = pts[(i + 3) % N];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ca = Math.hypot(a.x - c.x, a.y - c.y);
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross > 1e-6 && (ab * bc * ca) / (2 * cross) < minR) return false;
  }
  const skip = Math.ceil((width * 2) / TRACK_SPACING) + 4;
  const minD2 = (width + 30) * (width + 30);
  for (let i = 0; i < N; i += 2) {
    const p = pts[i];
    for (let j = i + skip; j < N; j += 2) {
      if (N - (j - i) <= skip) break;
      const q = pts[j], dx = p.x - q.x, dy = p.y - q.y;
      if (dx * dx + dy * dy < minD2) return false;
    }
  }
  return true;
}

function buildTrack(pts, width) {
  const N = pts.length, hw = width / 2;
  const x = new Float64Array(N), y = new Float64Array(N);
  const nx = new Float64Array(N), ny = new Float64Array(N), ang = new Float64Array(N);
  for (let i = 0; i < N; i++) { x[i] = pts[i].x; y[i] = pts[i].y; }
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    let tx = x[b] - x[a], ty = y[b] - y[a];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    nx[i] = -ty; ny[i] = tx;          // left-hand normal
    ang[i] = Math.atan2(ty, tx);
  }

  // Wall segments: 0..N-1 left edge, N..2N-1 right edge.
  const S = 2 * N;
  const sx1 = new Float64Array(S), sy1 = new Float64Array(S), sx2 = new Float64Array(S), sy2 = new Float64Array(S);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    sx1[i] = x[i] + nx[i] * hw; sy1[i] = y[i] + ny[i] * hw;
    sx2[i] = x[j] + nx[j] * hw; sy2[i] = y[j] + ny[j] * hw;
    sx1[N + i] = x[i] - nx[i] * hw; sy1[N + i] = y[i] - ny[i] * hw;
    sx2[N + i] = x[j] - nx[j] * hw; sy2[N + i] = y[j] - ny[j] * hw;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
  }
  const pad = width + GRID_CELL;
  const gx0 = minX - pad, gy0 = minY - pad;
  const cols = Math.ceil((maxX + pad - gx0) / GRID_CELL) + 1;
  const rows = Math.ceil((maxY + pad - gy0) / GRID_CELL) + 1;
  const cells = new Array(cols * rows).fill(null);
  for (let s = 0; s < S; s++) {
    const c0 = Math.floor((Math.min(sx1[s], sx2[s]) - gx0) / GRID_CELL);
    const c1 = Math.floor((Math.max(sx1[s], sx2[s]) - gx0) / GRID_CELL);
    const r0 = Math.floor((Math.min(sy1[s], sy2[s]) - gy0) / GRID_CELL);
    const r1 = Math.floor((Math.max(sy1[s], sy2[s]) - gy0) / GRID_CELL);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * cols + c;
      (cells[k] || (cells[k] = [])).push(s);
    }
  }

  return {
    N, width, hw, x, y, nx, ny, ang, length: N * TRACK_SPACING,
    sx1, sy1, sx2, sy2, segStamp: new Uint32Array(S), stamp: 1,
    grid: { gx0, gy0, cols, rows, cells },
    bounds: { minX: minX - hw, minY: minY - hw, maxX: maxX + hw, maxY: maxY + hw },
  };
}

// Nearest centerline sample to (px, py), searched in a small window around a guess.
function nearestIndex(track, px, py, guess, back, fwd) {
  const N = track.N, x = track.x, y = track.y;
  let best = guess, bestD = Infinity;
  for (let k = -back; k <= fwd; k++) {
    const i = ((guess + k) % N + N) % N;
    const dx = px - x[i], dy = py - y[i], d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Distance along a ray (ox,oy)+(dx,dy)*t to the first wall, capped at len.
function castWalls(track, ox, oy, dx, dy, len) {
  const g = track.grid, cells = g.cells;
  const ex = ox + dx * len, ey = oy + dy * len;
  const c0 = Math.max(0, Math.floor((Math.min(ox, ex) - g.gx0) / GRID_CELL));
  const c1 = Math.min(g.cols - 1, Math.floor((Math.max(ox, ex) - g.gx0) / GRID_CELL));
  const r0 = Math.max(0, Math.floor((Math.min(oy, ey) - g.gy0) / GRID_CELL));
  const r1 = Math.min(g.rows - 1, Math.floor((Math.max(oy, ey) - g.gy0) / GRID_CELL));
  const stamp = ++track.stamp;
  if (stamp >= 0xFFFFFFF0) { track.segStamp.fill(0); track.stamp = 1; }
  const sx1 = track.sx1, sy1 = track.sy1, sx2 = track.sx2, sy2 = track.sy2, seen = track.segStamp;
  let best = len;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = cells[r * g.cols + c];
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const s = cell[k];
        if (seen[s] === stamp) continue;
        seen[s] = stamp;
        const exs = sx2[s] - sx1[s], eys = sy2[s] - sy1[s];
        const den = dx * eys - dy * exs;
        if (den > -1e-9 && den < 1e-9) continue;
        const wx = sx1[s] - ox, wy = sy1[s] - oy;
        const t = (wx * eys - wy * exs) / den;
        if (t < 0 || t >= best) continue;
        const u = (wx * dy - wy * dx) / den;
        if (u >= 0 && u <= 1) best = t;
      }
    }
  }
  return best;
}

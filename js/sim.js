'use strict';

// ---------------------------------------------------------------------------
// Difficulty: one global level plus a stackable bonus per factor.
// Every factor keeps getting harder as its level rises and the track itself
// grows with the global level, so there is no ceiling.
// ---------------------------------------------------------------------------
const FACTORS = [
  { key: 'curves',  name: 'Curvy roads',     unlock: 0,  rate: 1.0 },
  { key: 'narrow',  name: 'Narrow lanes',    unlock: 0,  rate: 0.8 },
  { key: 'cones',   name: 'Road obstacles',  unlock: 1,  rate: 1.0 },
  { key: 'peds',    name: 'Pedestrians',     unlock: 3,  rate: 0.7 },
  { key: 'traffic', name: 'Traffic',         unlock: 5,  rate: 0.6 },
  { key: 'fog',     name: 'Fog',             unlock: 7,  rate: 0.6 },
  { key: 'noise',   name: 'Sensor noise',    unlock: 9,  rate: 0.5 },
  { key: 'ice',     name: 'Slippery roads',  unlock: 11, rate: 0.5 },
  { key: 'rush',    name: 'Time pressure',   unlock: 13, rate: 0.5 },
];

function factorLevels(level, bonus) {
  const out = {};
  for (const f of FACTORS) {
    const base = level > f.unlock ? Math.floor((level - f.unlock) * f.rate) : 0;
    out[f.key] = Math.max(0, base + (bonus[f.key] || 0));
  }
  return out;
}

function computeParams(level, bonus) {
  const f = factorLevels(level, bonus);
  const grow = 1 + 0.07 * (level - 1);               // tracks get longer forever
  const sat = (v, k) => 1 - Math.exp(-v / k);          // 0 → 1 saturating curve
  return {
    level, f,
    radius: 480 * grow,
    amplitude: 0.06 + 0.36 * sat(f.curves, 4),
    nPoints: Math.round(7 + 13 * sat(f.curves, 5) + (grow - 1) * 5),
    width: 52 + 80 * Math.exp(-f.narrow / 5),
    // Hazard densities creep toward a ceiling that is still passable, while the
    // track keeps growing — so counts rise forever but a level is never unbeatable.
    coneDensity: 3.2 * sat(f.cones, 9),                  // obstacles per 1000px of road
    pedDensity: 1.6 * sat(f.peds, 8),
    pedSpeed: 22 + 60 * sat(f.peds, 8),
    trafficDensity: 1.2 * sat(f.traffic, 8),
    trafficSpeed: 55 + 95 * sat(f.traffic, 10),
    oncoming: 0.5 * sat(Math.max(0, f.traffic - 1), 6),
    sensorRange: 230 * (0.4 + 0.6 * Math.exp(-f.fog / 5)),
    noise: 0.3 * sat(f.noise, 6),
    grip: 0.22 + 0.78 * Math.exp(-f.ice / 5),
    minAvgSpeed: 28 + 170 * sat(f.rush, 6),
    laps: 1,
  };
}

function describeFactor(key, p) {
  switch (key) {
    case 'curves':  return `bend ${Math.round(p.amplitude * 100)}% · ${p.nPoints} turns`;
    case 'narrow':  return `road ${Math.round(p.width)}px wide`;
    case 'cones':   return p.coneCount != null ? `${p.coneCount} on track` : '—';
    case 'peds':    return `${p.pedCount != null ? p.pedCount : '—'} @ ${Math.round(p.pedSpeed)}px/s`;
    case 'traffic': return `${p.trafficCount != null ? p.trafficCount : '—'} cars${p.oncoming > 0 ? ` · ${Math.round(p.oncoming * 100)}% oncoming` : ''}`;
    case 'fog':     return `sensors see ${Math.round(p.sensorRange)}px`;
    case 'noise':   return `±${Math.round(p.noise * 100)}% jitter`;
    case 'ice':     return `grip ${Math.round(p.grip * 100)}%`;
    case 'rush':    return `avg ≥ ${Math.round(p.minAvgSpeed)}px/s`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Obstacles. Moving ones are pure functions of time so every generation
// faces exactly the same situation — a fair exam for every brain.
// ---------------------------------------------------------------------------
const START_IDX = 2;
const START_CLEAR = 45;   // samples after the start line kept free of obstacles

function buildObstacles(track, p, seed) {
  const rand = mulberry32((seed * 31337 + 17) >>> 0);
  const N = track.N, hw = track.hw;
  const used = [];
  const free = (i, gap) => used.every(u => Math.min(Math.abs(u - i), N - Math.abs(u - i)) >= gap);
  const pick = (gap) => {
    for (let tries = 0; tries < 60; tries++) {
      const i = START_CLEAR + Math.floor(rand() * (N - START_CLEAR - 12));
      if (free(i, gap)) { used.push(i); return i; }
    }
    return -1;
  };
  const obs = [];

  const coneTarget = Math.round(p.coneDensity * track.length / 1000);
  for (let k = 0; k < coneTarget; k++) {
    const i = pick(11);
    if (i < 0) break;
    const r = 6 + rand() * 6;
    let off = (rand() * 2 - 1) * (hw - r - 2);
    const needGap = 28;
    if (hw - (off + r) < needGap && (off - r) + hw < needGap) off = rand() < 0.5 ? hw - r - 1 : -(hw - r - 1);
    obs.push({ type: 'cone', i, r, x: track.x[i] + track.nx[i] * off, y: track.y[i] + track.ny[i] * off, off });
  }

  const pedTarget = Math.round(p.pedDensity * track.length / 1000);
  for (let k = 0; k < pedTarget; k++) {
    const i = pick(10);
    if (i < 0) break;
    obs.push({ type: 'ped', i, r: 5, x: 0, y: 0, phase0: rand() * TAU, amp: hw + 14, speed: p.pedSpeed * (0.7 + rand() * 0.6) });
  }

  // Traffic starts well away from the grid so nobody is rear-ended at the line.
  const trafficTarget = Math.round(p.trafficDensity * track.length / 1000);
  for (let k = 0; k < trafficTarget; k++) {
    const dir = rand() < p.oncoming ? -1 : 1;
    const s0 = (START_CLEAR + 15 + rand() * Math.max(1, N - START_CLEAR - 75)) * TRACK_SPACING;
    obs.push({
      type: 'traffic', r: 9, x: 0, y: 0, h: 0, dir, s0,
      lane: -dir * hw * 0.45 * (0.8 + rand() * 0.4),       // drive on the right-hand lane of their direction
      speed: p.trafficSpeed * (0.7 + rand() * 0.5),
      hue: Math.floor(rand() * 360),
    });
  }
  p.coneCount = obs.filter(o => o.type === 'cone').length;
  p.pedCount = obs.filter(o => o.type === 'ped').length;
  p.trafficCount = obs.filter(o => o.type === 'traffic').length;
  return obs;
}

function updateObstacles(track, obs, t) {
  const N = track.N, L = track.length;
  for (const o of obs) {
    if (o.type === 'ped') {
      const phase = o.phase0 + (t * o.speed) / o.amp;
      const s = Math.sin(phase) * o.amp;
      o.x = track.x[o.i] + track.nx[o.i] * s;
      o.y = track.y[o.i] + track.ny[o.i] * s;
      o.moving = Math.cos(phase) >= 0 ? 1 : -1;
    } else if (o.type === 'traffic') {
      let s = (o.s0 + o.dir * o.speed * t) % L;
      if (s < 0) s += L;
      const fi = s / TRACK_SPACING, i = Math.floor(fi) % N, j = (i + 1) % N, f = fi - Math.floor(fi);
      const cx = track.x[i] + (track.x[j] - track.x[i]) * f, cy = track.y[i] + (track.y[j] - track.y[i]) * f;
      o.x = cx + track.nx[i] * o.lane;
      o.y = cy + track.ny[i] * o.lane;
      o.h = track.ang[i] + (o.dir < 0 ? Math.PI : 0);
    }
  }
}

function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const mx = ox - cx, my = oy - cy;
  const b = mx * dx + my * dy, c = mx * mx + my * my - r * r;
  if (c > 0 && b > 0) return Infinity;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------
const CAR_L = 22, CAR_W = 11;
const MAX_SPEED = 280, ACCEL = 240, BRAKE = 520, DRAG = 0.3, STEER_RATE = 3.0;
const RAY_ANGLES = [-90, -55, -30, -12, 0, 12, 30, 55, 90].map(d => d * Math.PI / 180);
const NUM_RAYS = RAY_ANGLES.length;
const NUM_INPUTS = NUM_RAYS + 4;
const NET_SHAPE = [NUM_INPUTS, 16, 12, 2];
const STATUS_MUL = { finished: 1, driving: 0.85, timeout: 0.85, stalled: 0.7, crashed: 0.5, 'wrong-way': 0.5 };

class Car {
  constructor(brain) {
    this.brain = brain;
    this.sensors = new Float32Array(NUM_RAYS);
    this.rayLen = new Float32Array(NUM_RAYS);
    this.inputs = new Float32Array(NUM_INPUTS);
  }

  reset(track) {
    const i = START_IDX;
    this.x = track.x[i]; this.y = track.y[i]; this.h = track.ang[i];
    this.vx = 0; this.vy = 0; this.speed = 0;
    this.idx = i; this.off = 0; this.lap = 0;
    this.progress = i; this.maxProgress = i; this.lastGain = 0;
    this.alive = true; this.status = 'driving'; this.cause = '';
    this.t = 0; this.finishTime = 0;
    this.nearMiss = 0; this.harsh = 0;
    this.steer = 0; this.throttle = 0;
    this.fitness = 0; this.safety = 0;
  }
}

// ---------------------------------------------------------------------------
// Simulation + genetic algorithm
// ---------------------------------------------------------------------------
class Simulation {
  constructor(opts = {}) {
    this.level = opts.level || 1;
    this.bonus = Object.fromEntries(FACTORS.map(f => [f.key, 0]));
    this.popSize = opts.popSize || 150;
    this.mutRate = 0.12;
    this.mutStrength = 0.35;
    this.boost = 1;
    this.autoAdvance = true;
    this.advanceThreshold = 75;
    this.newTrackEachGen = false;
    this.generation = 1;
    this.history = [];
    this.log = [];
    this.crashMarks = [];
    this.prevCrashMarks = [];
    this.bestSafetyOnLevel = 0;
    this.bestFitnessOnTrack = 0;
    this.sinceImprove = 0;
    this.champion = null;
    this.onEvent = null;
    this._near = [];
    this.trackSeed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 1e9);
    this.buildWorld();
    this.cars = [];
    for (let i = 0; i < this.popSize; i++) this.cars.push(new Car(new NeuralNet(NET_SHAPE)));
    this.startGeneration();
  }

  emit(msg) {
    this.log.unshift({ gen: this.generation, msg });
    if (this.log.length > 60) this.log.pop();
    if (this.onEvent) this.onEvent(msg);
  }

  buildWorld() {
    this.params = computeParams(this.level, this.bonus);
    this.track = generateTrack(this.trackSeed, this.params);
    this.obstacles = buildObstacles(this.track, this.params, this.trackSeed);
    this.timeLimit = (this.params.laps * this.track.length) / this.params.minAvgSpeed + 4;
    this.prevCrashMarks = [];
    this.crashMarks = [];
    this.bestFitnessOnTrack = 0;
    this.sinceImprove = 0;
    this.boost = 1;
  }

  newTrack(seed) {
    this.trackSeed = seed != null ? seed : Math.floor(Math.random() * 1e9);
    this.buildWorld();
    this.startGeneration();
  }

  // Apply level/factor changes immediately and re-run the current generation.
  applyDifficulty(keepTrack) {
    if (!keepTrack) this.trackSeed = Math.floor(Math.random() * 1e9);
    this.buildWorld();
    this.bestSafetyOnLevel = 0;
    this.startGeneration();
  }

  startGeneration() {
    this.time = 0;
    this.finishedCount = 0;
    this.aliveCount = this.cars.length;
    updateObstacles(this.track, this.obstacles, 0);
    for (const c of this.cars) c.reset(this.track);
  }

  step(dt) {
    updateObstacles(this.track, this.obstacles, this.time);
    let alive = 0;
    for (const car of this.cars) {
      if (!car.alive) continue;
      this.updateCar(car, dt);
      if (car.alive) alive++;
    }
    this.aliveCount = alive;
    this.time += dt;
    if (alive === 0 || this.time >= this.timeLimit) {
      this.endGeneration();
      return true;
    }
    return false;
  }

  updateCar(car, dt) {
    const tr = this.track, P = this.params, N = tr.N;
    const range = P.sensorRange;

    // Gather obstacles close enough to matter.
    const near = this._near;
    near.length = 0;
    for (const o of this.obstacles) {
      const dx = o.x - car.x, dy = o.y - car.y, rr = range + o.r;
      if (dx * dx + dy * dy < rr * rr) near.push(o);
    }

    // --- Sense
    for (let r = 0; r < NUM_RAYS; r++) {
      const a = car.h + RAY_ANGLES[r], dx = Math.cos(a), dy = Math.sin(a);
      let d = castWalls(tr, car.x, car.y, dx, dy, range);
      for (let k = 0; k < near.length; k++) {
        const o = near[k];
        const t = rayCircle(car.x, car.y, dx, dy, o.x, o.y, o.r);
        if (t < d) d = t;
      }
      car.rayLen[r] = d;
      let v = 1 - d / range;
      if (P.noise > 0) v += randn() * P.noise;
      car.sensors[r] = clamp(v, 0, 1);
    }

    // --- Think
    const inp = car.inputs;
    for (let r = 0; r < NUM_RAYS; r++) inp[r] = car.sensors[r];
    inp[NUM_RAYS] = car.speed / MAX_SPEED;
    inp[NUM_RAYS + 1] = clamp(car.off / tr.hw, -1.5, 1.5);
    inp[NUM_RAYS + 2] = Math.sin(wrapAngle(tr.ang[(car.idx + 4) % N] - car.h));
    inp[NUM_RAYS + 3] = clamp(wrapAngle(tr.ang[(car.idx + 18) % N] - tr.ang[car.idx]) / 1.2, -1, 1);
    const out = car.brain.forward(inp);

    // --- Act (steering has a little actuator lag, like a real rack)
    const prevSteer = car.steer;
    car.steer += (out[0] - car.steer) * Math.min(1, dt * 10);
    car.throttle = out[1];
    const steerRate = Math.abs(car.steer - prevSteer) / dt;
    if (steerRate > 3) car.harsh += (steerRate - 3) * dt;

    car.h += car.steer * STEER_RATE * dt * Math.min(1, car.speed / 80);
    const fx = Math.cos(car.h), fy = Math.sin(car.h);
    let vf = car.vx * fx + car.vy * fy;
    let lx = car.vx - fx * vf, ly = car.vy - fy * vf;
    vf += (car.throttle >= 0 ? car.throttle * ACCEL : car.throttle * BRAKE) * dt;
    vf -= vf * DRAG * dt;
    vf = clamp(vf, 0, MAX_SPEED);
    const keep = Math.exp(-P.grip * 12 * dt);           // low grip → the car slides
    lx *= keep; ly *= keep;
    car.vx = fx * vf + lx; car.vy = fy * vf + ly;
    car.speed = vf;
    car.x += car.vx * dt; car.y += car.vy * dt;
    car.t += dt;

    // --- Where am I on the road?
    const prevIdx = car.idx;
    car.idx = nearestIndex(tr, car.x, car.y, car.idx, 6, 14);
    const d = car.idx - prevIdx;
    if (d < -N / 2) car.lap++;
    else if (d > N / 2) car.lap--;
    car.progress = car.lap * N + car.idx;
    if (car.progress > car.maxProgress) { car.maxProgress = car.progress; car.lastGain = car.t; }
    const nx = tr.nx[car.idx], ny = tr.ny[car.idx];
    car.off = (car.x - tr.x[car.idx]) * nx + (car.y - tr.y[car.idx]) * ny;

    // --- Collisions with the road edge (check all four corners)
    const c = Math.cos(car.h), s = Math.sin(car.h);
    let edge = 0;
    for (let k = 0; k < 4; k++) {
      const lxc = (k & 1 ? 1 : -1) * CAR_L / 2, lyc = (k & 2 ? 1 : -1) * CAR_W / 2;
      const dn = (c * lxc - s * lyc) * nx + (s * lxc + c * lyc) * ny;
      edge = Math.max(edge, Math.abs(car.off + dn));
    }
    if (edge > tr.hw) return this.kill(car, 'crashed', 'hit the barrier');
    const margin = tr.hw - edge;
    if (margin < 6) car.nearMiss += dt * 0.5 * (1 - margin / 6);

    // --- Collisions with obstacles
    for (let k = 0; k < near.length; k++) {
      const o = near[k];
      const dx = o.x - car.x, dy = o.y - car.y;
      if (dx * dx + dy * dy > (o.r + 40) * (o.r + 40)) continue;
      const lxo = dx * c + dy * s, lyo = -dx * s + dy * c;
      const px = clamp(lxo, -CAR_L / 2, CAR_L / 2), py = clamp(lyo, -CAR_W / 2, CAR_W / 2);
      const dist = Math.hypot(lxo - px, lyo - py);
      if (dist < o.r) {
        const what = o.type === 'ped' ? 'hit a pedestrian' : o.type === 'traffic' ? 'hit another car' : 'hit an obstacle';
        return this.kill(car, 'crashed', what);
      }
      if (dist < o.r + 16) car.nearMiss += dt * (1 - (dist - o.r) / 16) * (o.type === 'ped' ? 3 : 1.5);
    }

    // --- Rules of the exam
    if (car.progress < car.maxProgress - 30) return this.kill(car, 'wrong-way', 'drove the wrong way');
    if (car.t - car.lastGain > 5) return this.kill(car, 'stalled', 'stalled');
    if (car.progress >= START_IDX + N * P.laps) {
      car.finishTime = car.t;
      this.finishedCount++;
      return this.kill(car, 'finished', 'finished');
    }
  }

  kill(car, status, cause) {
    car.alive = false;
    car.status = status;
    car.cause = cause;
    if (status === 'crashed') this.crashMarks.push({ x: car.x, y: car.y, cause });
    this.scoreCar(car);
  }

  // Safety score (0–100): how much of the course was covered, discounted by
  // close calls, jerky steering, and how the run ended. Fitness is what
  // evolution optimises: distance, strongly shaped by the same safety terms.
  scoreCar(car) {
    const N = this.track.N, target = N * this.params.laps;
    const dist = Math.max(0, car.maxProgress - START_IDX);
    const completion = clamp(dist / target, 0, 1);
    const penalty = Math.exp(-(car.nearMiss * 0.18 + car.harsh * 0.01));
    const mul = STATUS_MUL[car.status];
    car.completion = completion;
    car.penalty = penalty;
    car.safety = 100 * completion * penalty * mul;
    let fit = dist;
    if (car.status === 'finished') fit += target * (0.5 + 0.3 * (1 - car.finishTime / this.timeLimit));
    // Stopping forever in front of a hazard is no better than hitting it —
    // otherwise "park and wait" becomes a trap evolution can't escape.
    const fail = car.status === 'crashed' || car.status === 'wrong-way' || car.status === 'stalled';
    car.fitness = fit * Math.pow(penalty, 1.5) * (fail ? 0.5 : 1);
  }

  endGeneration() {
    for (const car of this.cars) {
      if (car.alive) { car.alive = false; car.status = 'timeout'; car.cause = 'ran out of time'; this.scoreCar(car); }
    }
    const cars = this.cars.slice().sort((a, b) => b.fitness - a.fitness);
    const best = cars[0];
    let bestSafety = 0, sumSafety = 0, crashes = 0;
    for (const c of cars) {
      bestSafety = Math.max(bestSafety, c.safety);
      sumSafety += c.safety;
      if (c.status === 'crashed') crashes++;
    }
    const avgSafety = sumSafety / cars.length;
    const safest = cars.reduce((a, b) => (b.safety > a.safety ? b : a));
    this.bestSafetyOnLevel = Math.max(this.bestSafetyOnLevel, bestSafety);
    this.history.push({
      gen: this.generation, level: this.level, best: bestSafety, avg: avgSafety,
      finished: this.finishedCount, crashes, pop: cars.length,
    });
    if (this.history.length > 2000) this.history.shift();

    if (!this.champion || this.champion.level < this.level || safest.safety >= this.champion.safety) {
      this.champion = { brain: safest.brain.clone(), safety: safest.safety, level: this.level, gen: this.generation };
    }

    // Stagnation → turn up mutation to shake things loose.
    if (best.fitness > this.bestFitnessOnTrack * 1.01) {
      this.bestFitnessOnTrack = best.fitness;
      this.sinceImprove = 0;
      this.boost = 1;
    } else if (++this.sinceImprove >= 6) {
      this.boost = Math.min(2, this.boost * 1.25);
    }

    this.lastGen = { best: bestSafety, avg: avgSafety, finished: this.finishedCount, crashes };
    this.evolve(cars);
    this.generation++;
    this.prevCrashMarks = this.crashMarks;
    this.crashMarks = [];

    const passed = safest.status === 'finished' && bestSafety >= this.advanceThreshold;
    if (this.autoAdvance && passed) {
      this.level++;
      this.emit(`Passed with safety ${bestSafety.toFixed(0)} → level ${this.level}`);
      this.trackSeed = Math.floor(Math.random() * 1e9);
      this.bestSafetyOnLevel = 0;
      this.buildWorld();
    } else if (this.newTrackEachGen) {
      this.trackSeed = Math.floor(Math.random() * 1e9);
      this.buildWorld();
    } else if (this.autoAdvance && this.sinceImprove >= 30) {
      // Hopelessly stuck on one nasty layout: try a fresh track at the same level.
      this.emit(`No progress for 30 generations: new track at level ${this.level}`);
      this.trackSeed = Math.floor(Math.random() * 1e9);
      this.buildWorld();
    }
    this.startGeneration();
  }

  evolve(sorted) {
    const n = this.popSize;
    const next = [];
    const eliteN = Math.min(sorted.length, Math.max(2, Math.round(n * 0.05)));
    for (let i = 0; i < eliteN; i++) next.push(sorted[i].brain.clone());
    if (this.champion) next.push(this.champion.brain.clone());
    const pool = sorted.slice(0, Math.max(2, Math.ceil(sorted.length * 0.4)));
    const tournament = () => {
      let b = pool[Math.floor(Math.random() * pool.length)];
      for (let k = 0; k < 2; k++) {
        const c = pool[Math.floor(Math.random() * pool.length)];
        if (c.fitness > b.fitness) b = c;
      }
      return b.brain;
    };
    const immigrants = Math.floor(n * 0.02);
    while (next.length < n - immigrants) {
      const a = tournament();
      const child = Math.random() < 0.7 ? NeuralNet.crossover(a, tournament()) : a.clone();
      // Mix tiny refinements with bold jumps; only the bold half gets the
      // stagnation boost, so fine-tuning never stops.
      const bold = next.length % 2 === 1;
      const scale = bold ? this.boost : Math.pow(10, -Math.random() * 1.3);
      child.mutate(this.mutRate * scale, this.mutStrength * scale);
      next.push(child);
    }
    while (next.length < n) next.push(new NeuralNet(NET_SHAPE));
    next.length = n;
    this.cars = next.map(b => new Car(b));
  }

  // Replace the whole population with mutated copies of one brain.
  seedFrom(brain) {
    this.cars = [];
    for (let i = 0; i < this.popSize; i++) {
      const b = brain.clone();
      if (i > 0) b.mutate(this.mutRate, this.mutStrength);
      this.cars.push(new Car(b));
    }
    this.startGeneration();
  }

  resetBrains() {
    this.cars = [];
    for (let i = 0; i < this.popSize; i++) this.cars.push(new Car(new NeuralNet(NET_SHAPE)));
    this.champion = null;
    this.bestFitnessOnTrack = 0;
    this.boost = 1;
    this.startGeneration();
  }

  leader() {
    let best = null;
    for (const c of this.cars) if (c.alive && (!best || c.progress > best.progress)) best = c;
    if (best) return best;
    for (const c of this.cars) if (!best || c.maxProgress > best.maxProgress) best = c;
    return best;
  }
}

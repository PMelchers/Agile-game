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
const START_CLEAR = 70;   // samples after the start line kept free of obstacles, so the pack can spread out
const HAZARD_GAP = 17;    // min samples between hazards (170px ≈ 0.6s at full speed)

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
    const i = pick(HAZARD_GAP);
    if (i < 0) break;
    // Every cone leaves a lane wide enough to pass cleanly, outside the close-call zone.
    const needGap = CAR_W + 2 * (CLOSE_CALL + 4);
    const r = Math.min(6 + rand() * 6, Math.max(4, (2 * hw - needGap - 1) / 2));
    let off = (rand() * 2 - 1) * (hw - r - 2);
    if (hw - (off + r) < needGap && (off - r) + hw < needGap) off = rand() < 0.5 ? hw - r - 1 : -(hw - r - 1);
    obs.push({ type: 'cone', i, r, x: track.x[i] + track.nx[i] * off, y: track.y[i] + track.ny[i] * off, off });
  }

  const pedTarget = Math.round(p.pedDensity * track.length / 1000);
  for (let k = 0; k < pedTarget; k++) {
    const i = pick(HAZARD_GAP);
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

// Obstacles the user places by hand. Specs are stored per track so they come
// back every generation (and after a reload) until the track changes.
const PLACEABLE = {
  cone:   { label: 'Cone', hint: 'small, easy to see' },
  rock:   { label: 'Rock', hint: 'big and static' },
  parked: { label: 'Parked car', hint: 'blocks part of a lane' },
  ped:    { label: 'Pedestrian', hint: 'crosses back and forth' },
  slow:   { label: 'Slow car', hint: 'drives the lap slowly' },
};

function makeCustomObstacle(track, p, spec) {
  const N = track.N, hw = track.hw, i = ((spec.i % N) + N) % N;
  const at = off => ({ x: track.x[i] + track.nx[i] * off, y: track.y[i] + track.ny[i] * off });
  let o;
  if (spec.kind === 'cone' || spec.kind === 'rock') {
    const r = spec.r || (spec.kind === 'rock' ? 14 : 8);
    const off = clamp(spec.off, -hw, hw);
    o = { type: spec.kind, i, r, off, ...at(off) };
  } else if (spec.kind === 'parked') {
    const off = clamp(spec.off, -(hw - 5), hw - 5);
    o = { type: 'parked', i, r: 9, off, h: track.ang[i], hue: 210, ...at(off) };
  } else if (spec.kind === 'ped') {
    o = { type: 'ped', i, r: 5, x: 0, y: 0, phase0: spec.phase || 0, amp: hw + 14, speed: p.pedSpeed };
  } else {
    o = {
      type: 'traffic', r: 9, x: 0, y: 0, h: 0, dir: 1, s0: i * TRACK_SPACING,
      lane: clamp(spec.off, -hw * 0.6, hw * 0.6), speed: Math.max(35, p.trafficSpeed * 0.55), hue: 45,
    };
  }
  o.custom = true;
  o.spec = spec;
  return o;
}

const OBSTACLE_CAUSE = {
  cone: ['obstacle', 'hit a cone'], rock: ['obstacle', 'hit a rock'],
  ped: ['ped', 'hit a pedestrian'], traffic: ['car', 'hit another car'], parked: ['car', 'hit a parked car'],
};
const CLOSE_LABEL = { barrier: 'barrier', cone: 'cone', rock: 'rock', ped: 'pedestrian', traffic: 'car', parked: 'parked car' };

// Where an obstacle is at time t. Moving obstacles are pure functions of
// time, which is also what lets a mistake be replayed exactly.
const _pos = { x: 0, y: 0, h: 0 };
function obstaclePosAt(track, o, t) {
  if (o.type === 'ped') {
    const s = Math.sin(o.phase0 + (t * o.speed) / o.amp) * o.amp;
    _pos.x = track.x[o.i] + track.nx[o.i] * s;
    _pos.y = track.y[o.i] + track.ny[o.i] * s;
    _pos.h = 0;
  } else if (o.type === 'traffic') {
    const N = track.N, L = track.length;
    let s = (o.s0 + o.dir * o.speed * t) % L;
    if (s < 0) s += L;
    const fi = s / TRACK_SPACING, i = Math.floor(fi) % N, j = (i + 1) % N, f = fi - Math.floor(fi);
    _pos.x = track.x[i] + (track.x[j] - track.x[i]) * f + track.nx[i] * o.lane;
    _pos.y = track.y[i] + (track.y[j] - track.y[i]) * f + track.ny[i] * o.lane;
    _pos.h = track.ang[i] + (o.dir < 0 ? Math.PI : 0);
  } else {
    _pos.x = o.x; _pos.y = o.y; _pos.h = o.h || 0;
  }
  return _pos;
}

function updateObstacles(track, obs, t) {
  for (const o of obs) {
    if (o.type !== 'ped' && o.type !== 'traffic') continue;
    const p = obstaclePosAt(track, o, t);
    o.x = p.x; o.y = p.y; o.h = p.h;
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
const CLOSE_CALL = 10;   // px of clearance below which a pass counts as a close call
const MAX_SPEED = 280, ACCEL = 240, BRAKE = 520, DRAG = 0.3, STEER_RATE = 3.0;
// Sensor lines fan out from -90° to +90°, packed more densely towards the
// front. The count is adjustable, so these are set by setSensorCount().
const LEGACY_RAY_DEG = [-90, -55, -30, -12, 0, 12, 30, 55, 90];   // layout used by saves before sensors were adjustable
const SENSOR_MIN = 5, SENSOR_MAX = 31, SENSOR_DEFAULT = 15;
const HIDDEN_SHAPE = [16, 12, 2];
const SNAP_STATE = 9;        // x, y, h, vx, vy, speed, steer, idx, time
let RAY_ANGLES, NUM_RAYS, NUM_INPUTS, NET_SHAPE, RECENT_W;
function rayAnglesFor(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : -1 + (2 * k) / (n - 1);
    out.push(Math.sign(t) * Math.pow(Math.abs(t), 1.35) * Math.PI / 2);
  }
  return out;
}
function setSensorCount(n) {
  n = clamp(Math.round(n), SENSOR_MIN, SENSOR_MAX);
  if (n % 2 === 0) n++;                                      // odd, so one line looks straight ahead
  RAY_ANGLES = rayAnglesFor(n);
  NUM_RAYS = n;
  NUM_INPUTS = n + 4;
  NET_SHAPE = [NUM_INPUTS, ...HIDDEN_SHAPE];
  RECENT_W = NUM_INPUTS + 2 + SNAP_STATE;
  return n;
}
setSensorCount(SENSOR_DEFAULT);

// Rebuild a brain for a different set of sensor lines. Each new line takes
// the connections of the nearest old line (shared out if several new lines
// map onto one), so the car keeps what it had learned.
function remapBrain(net, oldAngles, newAngles) {
  const oldRays = oldAngles.length, newRays = newAngles.length;
  const oldIn = net.sizes[0], extra = oldIn - oldRays, newIn = newRays + extra, H = net.sizes[1];
  const out = new NeuralNet([newIn, ...net.sizes.slice(1)]);
  const near = newAngles.map(a => {
    let b = 0;
    for (let k = 1; k < oldRays; k++) if (Math.abs(oldAngles[k] - a) < Math.abs(oldAngles[b] - a)) b = k;
    return b;
  });
  const count = new Array(oldRays).fill(0);
  near.forEach(k => count[k]++);
  for (let j = 0; j < H; j++) {
    const oo = j * (oldIn + 1), no = j * (newIn + 1);
    for (let r = 0; r < newRays; r++) out.w[no + r] = net.w[oo + near[r]] / count[near[r]];
    for (let e = 0; e < extra; e++) out.w[no + newRays + e] = net.w[oo + oldRays + e];
    out.w[no + newIn] = net.w[oo + oldIn];
  }
  out.w.set(net.w.subarray((oldIn + 1) * H), (newIn + 1) * H);
  return out;
}

// Make a saved or imported brain fit the current sensor lines. `savedSensors`
// is the sensor count stored with it (missing for brains from before
// sensors were adjustable, which used LEGACY_RAY_DEG).
function adaptBrain(brain, savedSensors) {
  if (brain.sizes.slice(1).join() !== HIDDEN_SHAPE.join() || brain.sizes[0] < 5) {
    throw new Error('This brain has a different network shape.');
  }
  const rays = brain.sizes[0] - 4;
  const angles = !savedSensors && rays === 9 ? LEGACY_RAY_DEG.map(d => d * Math.PI / 180) : rayAnglesFor(rays);
  if (savedSensors === rays && rays === NUM_RAYS) return brain;
  return remapBrain(brain, angles, RAY_ANGLES);
}

// Car physics, shared by the real cars and by mistake replays.
function drivePhysics(c, steerOut, throttle, dt, grip) {
  c.steer += (steerOut - c.steer) * Math.min(1, dt * 10);   // steering has a little actuator lag
  c.h += c.steer * STEER_RATE * dt * Math.min(1, c.speed / 80);
  const fx = Math.cos(c.h), fy = Math.sin(c.h);
  let vf = c.vx * fx + c.vy * fy;
  let lx = c.vx - fx * vf, ly = c.vy - fy * vf;
  vf += (throttle >= 0 ? throttle * ACCEL : throttle * BRAKE) * dt;
  vf -= vf * DRAG * dt;
  vf = clamp(vf, 0, MAX_SPEED);
  const keep = Math.exp(-grip * 12 * dt);                  // low grip → the car slides
  lx *= keep; ly *= keep;
  c.vx = fx * vf + lx; c.vy = fy * vf + ly;
  c.speed = vf;
  c.x += c.vx * dt; c.y += c.vy * dt;
}

// Distance from an obstacle to the car's body (0 or less = touching).
function carGap(cx, cy, c, s, ox, oy, r) {
  const dx = ox - cx, dy = oy - cy;
  const lxo = dx * c + dy * s, lyo = -dx * s + dy * c;
  const px = clamp(lxo, -CAR_L / 2, CAR_L / 2), py = clamp(lyo, -CAR_W / 2, CAR_W / 2);
  return Math.hypot(lxo - px, lyo - py) - r;
}
const TRACE_LEN = 300;       // samples kept per car (30 s at 10 Hz)
const TRACE_EVERY = 6;       // sim steps between samples
const TRACE_CH = 4;          // speed, steering, throttle, clearance
const RECENT_LEN = 12;       // snapshots kept for lessons (1.2 s at 10 Hz)
const MEMORY_MAX = 1500;     // lessons the fleet remembers
const REPLAY_STEER = [-1, -0.5, 0, 0.5, 1];
const REPLAY_GAS = [-0.7, 0.15, 0.8];

// Turn one moment before a mistake into a lesson: "in this situation you
// should have ...". x = what the sensors saw, s/t = the steering and
// gas/brake the car chose, u = how close to the mistake (1 = the last moment).
function lessonTarget(x, s, t, kind, u) {
  if (kind === 'stalled') return [s, 0.9];                     // keep driving
  let left = 0, right = 0, front = 0;
  for (let r = 0; r < NUM_RAYS; r++) {                          // sensor value 1 = something touching
    const a = RAY_ANGLES[r];
    if (a < -0.05) left += x[r]; else if (a > 0.05) right += x[r];
    if (Math.abs(a) < 0.3) front = Math.max(front, x[r]);
  }
  const away = right > left ? -1 : 1;                           // steer towards the more open side
  const steer = clamp(s + away * (0.45 + 0.55 * front) * u, -1, 1);
  const fast = x[NUM_RAYS] > 0.35;                              // speed input, 1 = top speed
  const gas = fast ? clamp(t - (0.3 + 0.6 * front) * u, -1, 1) : Math.max(t, 0.3);
  return [steer, gas];
}
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
    this.px = this.x; this.py = this.y; this.ph = this.h;
    this.vx = 0; this.vy = 0; this.speed = 0;
    this.idx = i; this.off = 0; this.lap = 0;
    this.progress = i; this.maxProgress = i; this.lastGain = 0;
    this.alive = true; this.status = 'driving'; this.cause = '';
    this.t = 0; this.finishTime = 0;
    this.nearMiss = 0; this.harsh = 0;
    this.steer = 0; this.throttle = 0;
    this.fitness = 0; this.safety = 0;
    this.outcome = '';
    this.trace = new Float32Array(TRACE_LEN * TRACE_CH);
    this.traceN = 0; this.steps = 0;
    this.recent = new Float32Array(RECENT_LEN * RECENT_W);
    this.recentN = 0;
    this.lessons = 0; this.lessonsPending = 0; this.lastLearnLog = -9; this.learnedFrom = [];
    this.clearance = Infinity;
    this.events = [];
    this.ccActive = false; this.harshActive = false; this.brakeActive = false;
  }

  logEvent(kind, text) {
    if (this.events.length < 80) this.events.push({ t: this.t, kind, text });
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
    // Learning from mistakes: every crash, stall or close call becomes a
    // lesson that every car still driving trains on straight away.
    this.learnOn = true;
    this.learnRate = 0.05;
    this.memory = [];
    this.mistakesThisGen = 0;
    this.lessonsThisGen = 0;
    this.lessonFx = [];
    this.lastTeach = -9;
    this._newMistakes = [];
    this._teachTimer = 0;
    this._queue = [];
    this._replayNear = [];
    this._ghost = { x: 0, y: 0, h: 0, vx: 0, vy: 0, speed: 0, steer: 0 };
    this.replayWins = 0;
    this.custom = [];
    this.customSeed = this.trackSeed;
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
    if (this.customSeed !== this.trackSeed) { this.custom = []; this.customSeed = this.trackSeed; }
    this.obstacles = buildObstacles(this.track, this.params, this.trackSeed)
      .concat(this.custom.map(spec => makeCustomObstacle(this.track, this.params, spec)));
    this.timeLimit = (this.params.laps * this.track.length) / this.params.minAvgSpeed + 4;
    this.prevCrashMarks = [];
    this.crashMarks = [];
    this.bestFitnessOnTrack = 0;
    this.sinceImprove = 0;
    this.boost = 1;
    this.bestSafetyOnTrack = 0;
    this.stuckGens = 0;
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
    for (const o of this.obstacles) { o.px = o.x; o.py = o.y; o.ph = o.h; }
    this.cars.forEach((c, k) => { c.id = k + 1; c.reset(this.track); });
    this.mistakesThisGen = 0;
    this.lessonsThisGen = 0;
    this.lessonFx = [];
    this._newMistakes = [];
    this._queue = [];
    // Before setting off, every new car studies what the fleet has learned so far.
    if (this.learnOn && this.memory.length) {
      for (const c of this.cars) {
        for (let k = 0; k < 40; k++) this.study(c.brain, this.memory[Math.floor(Math.random() * this.memory.length)]);
      }
    }
  }

  // ---- hand-placed obstacles ------------------------------------------------
  placeObstacle(kind, x, y, size) {
    const tr = this.track, N = tr.N;
    let i = 0, bd = Infinity;
    for (let k = 0; k < N; k++) {
      const dx = x - tr.x[k], dy = y - tr.y[k], d = dx * dx + dy * dy;
      if (d < bd) { bd = d; i = k; }
    }
    const off = (x - tr.x[i]) * tr.nx[i] + (y - tr.y[i]) * tr.ny[i];
    if (Math.abs(off) > tr.hw + 2) return 'off-road';
    if (Math.min(i, N - i) < 10) return 'start';
    const spec = { kind, i, off: clamp(off, -tr.hw, tr.hw) };
    if (kind === 'cone' || kind === 'rock') spec.r = size;
    if (kind === 'ped') spec.phase = Math.asin(clamp(off / (tr.hw + 14), -1, 1));
    const o = makeCustomObstacle(tr, this.params, spec);
    // Appear exactly where clicked right now, even mid-generation.
    if (o.type === 'ped') o.phase0 = spec.phase - (this.time * o.speed) / o.amp;
    if (o.type === 'traffic') o.s0 = i * TRACK_SPACING - o.speed * this.time;
    this.custom.push(spec);
    this.obstacles.push(o);
    updateObstacles(tr, [o], this.time);
    return 'ok';
  }

  removeObstacleAt(x, y, reach) {
    let best = -1, bd = Infinity;
    this.obstacles.forEach((o, k) => {
      const d = Math.hypot(o.x - x, o.y - y) - o.r;
      if (d < bd) { bd = d; best = k; }
    });
    if (best < 0 || bd > reach) return null;
    const [o] = this.obstacles.splice(best, 1);
    if (o.custom) this.custom = this.custom.filter(s => s !== o.spec);
    return o;
  }

  clearCustomObstacles() {
    this.obstacles = this.obstacles.filter(o => !o.custom);
    this.custom = [];
  }

  clearAllObstacles() {
    this.obstacles = [];
    this.custom = [];
  }

  // ---- learning from mistakes --------------------------------------------
  // A mistake is queued with snapshots from 0.9 s, 0.5 s and 0.2 s before it.
  // processMistakes() replays each snapshot with other choices to find what
  // would have worked, and that becomes the lesson every car learns.
  recordMistake(car, kind, cause) {
    if (!this.learnOn) return;
    const n = Math.min(car.recentN, RECENT_LEN);
    if (!n) return;
    const backs = kind === 'close' ? [2] : kind === 'stalled' ? [0, 3] : [9, 5, 2];
    const snaps = [];
    for (const k of backs) {
      if (k >= n) continue;
      const o = ((car.recentN - 1 - k) % RECENT_LEN) * RECENT_W;
      snaps.push({ rec: car.recent.slice(o, o + RECENT_W), u: 1 - k / RECENT_LEN });
    }
    if (!snaps.length) return;
    if (this._queue.length >= 60) this._queue.shift();          // too many at once: drop the oldest
    this._queue.push({ car: car.id, kind, cause, snaps });
    if (kind !== 'close') {
      this.mistakesThisGen++;
      this.lessonFx.push({ x: car.x, y: car.y, t: this.time });
    }
  }

  processMistakes(budgetMs) {
    const t0 = performance.now();
    let done = 0;
    while (this._queue.length && (done === 0 || performance.now() - t0 < budgetMs)) {
      const m = this._queue.shift();
      for (const sn of m.snaps) {
        const rec = sn.rec, x = rec.slice(0, NUM_INPUTS), s = rec[NUM_INPUTS], t = rec[NUM_INPUTS + 1];
        let y = null, w;
        if (m.kind !== 'stalled') {
          const best = this.replay(rec);
          if (best) { y = best; w = (m.kind === 'close' ? 0.5 : 1) * (0.5 + 0.5 * sn.u); this.replayWins++; }
        }
        if (!y) {                                                // no replay found a way out: fall back to the rule of thumb
          y = lessonTarget(x, s, t, m.kind, sn.u);
          w = (m.kind === 'close' ? 0.3 : 0.6) * (0.5 + 0.5 * sn.u);
        }
        this.memory.push({ x, y, w });
      }
      this._newMistakes.push(m);
      done++;
    }
    if (this.memory.length > MEMORY_MAX) this.memory.splice(0, this.memory.length - MEMORY_MAX);
  }

  // Try every candidate choice from a saved moment and return the one that
  // stays safest while still making progress (or null if all of them crash).
  replay(rec) {
    const b = NUM_INPUTS + 2;
    const start = { x: rec[b], y: rec[b + 1], h: rec[b + 2], vx: rec[b + 3], vy: rec[b + 4], speed: rec[b + 5], steer: rec[b + 6] };
    const idx0 = rec[b + 7] | 0, time0 = rec[b + 8];
    const near = this._replayNear;
    near.length = 0;
    for (const o of this.obstacles) {
      if ((o.x - start.x) ** 2 + (o.y - start.y) ** 2 < 520 * 520) near.push(o);
    }
    let best = null, bestScore = -Infinity;
    for (const gs of REPLAY_GAS) {
      for (const ss of REPLAY_STEER) {
        const sc = this.imagine(start, idx0, time0, ss, gs, near);
        if (sc > bestScore) { bestScore = sc; best = [ss, gs]; }
      }
    }
    return bestScore > -500 ? best : null;
  }

  // Simulate 1.4 s from a saved moment: hold one choice for 0.5 s, then drive
  // calmly along the road. Score = progress + clearance kept; a crash scores low.
  imagine(start, idx0, time0, steerT, gasT, near) {
    const tr = this.track, P = this.params, N = tr.N, dt = 1 / 60, st = this._ghost;
    st.x = start.x; st.y = start.y; st.h = start.h; st.vx = start.vx; st.vy = start.vy; st.speed = start.speed; st.steer = start.steer;
    let idx = idx0, prog = 0, minGap = 20, off = 0;
    for (let k = 0; k < 84; k++) {
      let sT = steerT, gT = gasT;
      if (k >= 30) {
        const la = (idx + 6) % N;
        sT = clamp(2.2 * Math.sin(wrapAngle(tr.ang[la] - st.h)) - 0.02 * off, -1, 1);
        gT = 0.3;
      }
      drivePhysics(st, sT, gT, dt, P.grip);
      const ni = nearestIndex(tr, st.x, st.y, idx, 6, 14);
      let d = ni - idx;
      if (d < -N / 2) d += N; else if (d > N / 2) d -= N;
      prog += d; idx = ni;
      const nx = tr.nx[idx], ny = tr.ny[idx];
      off = (st.x - tr.x[idx]) * nx + (st.y - tr.y[idx]) * ny;
      const c = Math.cos(st.h), s = Math.sin(st.h);
      let edge = 0;
      for (let q = 0; q < 4; q++) {
        const lxc = (q & 1 ? 1 : -1) * CAR_L / 2, lyc = (q & 2 ? 1 : -1) * CAR_W / 2;
        edge = Math.max(edge, Math.abs(off + (c * lxc - s * lyc) * nx + (s * lxc + c * lyc) * ny));
      }
      if (edge > tr.hw) return -1000 + k;
      minGap = Math.min(minGap, tr.hw - edge);
      const tt = time0 + (k + 1) * dt;
      for (let q = 0; q < near.length; q++) {
        const o = near[q], p = obstaclePosAt(tr, o, tt);
        const g = carGap(st.x, st.y, c, s, p.x, p.y, o.r);
        if (g < 0) return -1000 + k;
        if (g < minGap) minGap = g;
      }
    }
    return prog * TRACK_SPACING + Math.min(minGap, 15) * 8;
  }

  study(brain, lesson) {
    brain.train(lesson.x, lesson.y, this.learnRate * lesson.w);
  }

  // Every car still driving trains on the newest lessons (plus a few older
  // ones, so it doesn't forget earlier mistakes).
  teachFleet() {
    this._teachTimer = 0;
    const fresh = this._newMistakes;
    this._newMistakes = [];
    const mem = this.memory, n = mem.length;
    if (!n) return;
    const recent = Math.min(n, 3 * fresh.length + 6);
    let taught = 0;
    for (const c of this.cars) {
      if (!c.alive) continue;
      for (let k = 0; k < 10; k++) {
        const idx = k < 7 ? n - 1 - Math.floor(Math.random() * recent) : Math.floor(Math.random() * n);
        this.study(c.brain, mem[idx]);
      }
      c.lessons += fresh.length;
      c.lessonsPending += fresh.length;
      for (const f of fresh) if (c.learnedFrom.length < 3 && f.kind !== 'close') c.learnedFrom.push(`car ${f.car} (${f.cause})`);
      if (c.t - c.lastLearnLog >= 1.5) {
        const from = c.learnedFrom.length ? `: ${c.learnedFrom.join(', ')}${c.lessonsPending > c.learnedFrom.length ? '…' : ''}` : ' (close calls)';
        c.logEvent('learn', `Learned from ${c.lessonsPending} mistake${c.lessonsPending === 1 ? '' : 's'}${from}`);
        c.lastLearnLog = c.t; c.lessonsPending = 0; c.learnedFrom = [];
      }
      taught++;
    }
    this.lessonsThisGen += fresh.length * taught;
    if (taught) this.lastTeach = this.time;
  }

  // Change how many sensor lines every car has; brains are adapted, not reset.
  setSensors(n) {
    const oldA = RAY_ANGLES;
    setSensorCount(n);
    if (RAY_ANGLES.length === oldA.length) return false;
    this.cars = this.cars.map(c => new Car(remapBrain(c.brain, oldA, RAY_ANGLES)));
    if (this.champion) this.champion.brain = remapBrain(this.champion.brain, oldA, RAY_ANGLES);
    this.memory = [];
    this.startGeneration();
    return true;
  }

  // Safety score a car would get if it stopped right now.
  liveSafety(car) {
    if (!car.alive) return car.safety;
    const dist = Math.max(0, car.maxProgress - START_IDX);
    const completion = clamp(dist / (this.track.N * this.params.laps), 0, 1);
    return 100 * completion * Math.exp(-(car.nearMiss * 0.18 + car.harsh * 0.01));
  }

  step(dt) {
    // Remember where everything was so the renderer can draw smoothly between steps.
    for (const o of this.obstacles) { o.px = o.x; o.py = o.y; o.ph = o.h; }
    updateObstacles(this.track, this.obstacles, this.time);
    let alive = 0;
    for (const car of this.cars) {
      if (!car.alive) continue;
      car.px = car.x; car.py = car.y; car.ph = car.h;
      this.updateCar(car, dt);
      if (car.alive) alive++;
    }
    this.aliveCount = alive;
    this.time += dt;
    this._teachTimer += dt;
    if (this._queue.length) this.processMistakes(1.2);
    if (this._newMistakes.length && this._teachTimer >= 0.2) this.teachFleet();
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

    // Snapshot of this moment (what it saw, what it chose, where it was), kept
    // for 1.2 s so a mistake can be replayed from here.
    if (car.steps % TRACE_EVERY === 0) {
      const o = (car.recentN % RECENT_LEN) * RECENT_W, r = car.recent, b = o + NUM_INPUTS;
      r.set(inp, o);
      r[b] = out[0]; r[b + 1] = out[1];
      r[b + 2] = car.x; r[b + 3] = car.y; r[b + 4] = car.h; r[b + 5] = car.vx; r[b + 6] = car.vy;
      r[b + 7] = car.speed; r[b + 8] = car.steer; r[b + 9] = car.idx; r[b + 10] = this.time;
      car.recentN++;
    }

    // --- Act
    const prevSteer = car.steer;
    drivePhysics(car, out[0], out[1], dt, P.grip);
    car.throttle = out[1];
    car.outSteer = out[0];
    const steerRate = Math.abs(car.steer - prevSteer) / dt;
    if (steerRate > 3) car.harsh += (steerRate - 3) * dt;
    if (steerRate > 6 && !car.harshActive) car.logEvent('warn', `Jerky steering (${car.steer < 0 ? 'left' : 'right'})`);
    car.harshActive = steerRate > 4;
    if (car.throttle < -0.5 && !car.brakeActive && car.speed > 60) car.logEvent('info', `Braked hard at ${Math.round(car.speed)} px/s`);
    car.brakeActive = car.throttle < -0.3;
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
    if (edge > tr.hw) return this.kill(car, 'crashed', 'hit the barrier', 'wall');
    const margin = tr.hw - edge;
    let closeKind = null, closeGap = Infinity;
    if (margin < 4) { car.nearMiss += dt * 0.5 * (1 - margin / 4); closeKind = 'barrier'; closeGap = margin; }

    // --- Collisions with obstacles
    for (let k = 0; k < near.length; k++) {
      const o = near[k];
      const dx = o.x - car.x, dy = o.y - car.y;
      if (dx * dx + dy * dy > (o.r + 40) * (o.r + 40)) continue;
      const dist = carGap(car.x, car.y, c, s, o.x, o.y, o.r) + o.r;
      if (dist < o.r) {
        const [key, what] = OBSTACLE_CAUSE[o.type];
        return this.kill(car, 'crashed', what, key);
      }
      // Close-call zone is small enough that even the narrowest road leaves a clean line past every hazard.
      if (dist < o.r + CLOSE_CALL) {
        car.nearMiss += dt * (1 - (dist - o.r) / CLOSE_CALL) * (o.type === 'ped' ? 3 : 1.5);
        if (dist - o.r < closeGap) { closeGap = dist - o.r; closeKind = o.type; }
      }
    }
    if (closeKind && !car.ccActive) {
      car.logEvent('warn', `Close call with ${CLOSE_LABEL[closeKind]} (${Math.max(0, closeGap).toFixed(0)}px)`);
      this.recordMistake(car, 'close', `close call with ${CLOSE_LABEL[closeKind]}`);
    }
    car.ccActive = !!closeKind;

    // --- Telemetry
    let clr = Infinity;
    for (let r = 0; r < NUM_RAYS; r++) if (car.rayLen[r] < clr) clr = car.rayLen[r];
    car.clearance = clr;
    if (car.steps++ % TRACE_EVERY === 0) {
      const o = (car.traceN % TRACE_LEN) * TRACE_CH;
      car.trace[o] = car.speed; car.trace[o + 1] = car.steer; car.trace[o + 2] = car.throttle; car.trace[o + 3] = clr;
      car.traceN++;
    }

    // --- Rules of the exam
    if (car.progress < car.maxProgress - 30) return this.kill(car, 'wrong-way', 'drove the wrong way', 'other');
    if (car.t - car.lastGain > 5) return this.kill(car, 'stalled', 'stalled', 'other');
    // Cars that never really set off only clutter the start line.
    if (car.t > 2.5 && car.maxProgress - START_IDX < 3) return this.kill(car, 'stalled', 'never got going', 'other');
    if (car.progress >= START_IDX + N * P.laps) {
      car.finishTime = car.t;
      this.finishedCount++;
      return this.kill(car, 'finished', 'finished', 'finished');
    }
  }

  kill(car, status, cause, outcome) {
    car.alive = false;
    car.status = status;
    car.cause = cause;
    car.outcome = outcome;
    car.px = car.x; car.py = car.y; car.ph = car.h;
    if (status === 'crashed' || status === 'stalled') this.recordMistake(car, status, cause);
    if (status === 'crashed' || status === 'stalled' || status === 'wrong-way') {
      this.crashMarks.push({
        x: car.x, y: car.y, key: outcome, cause, car: car.id, gen: this.generation, t: car.t,
        pct: clamp((car.maxProgress - START_IDX) / (this.track.N * this.params.laps), 0, 1) * 100,
      });
    }
    if (status === 'finished') car.logEvent('good', `Finished the lap in ${car.t.toFixed(1)}s`);
    else if (status === 'crashed') car.logEvent('bad', `Crashed: ${cause}`);
    else car.logEvent('bad', status === 'stalled' ? (cause === 'never got going' ? 'Never got going' : 'Stalled: no progress for 5s') : status === 'wrong-way' ? 'Turned around and drove the wrong way' : 'Ran out of time');
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
    if (car.status === 'finished') fit += target * (0.5 + 0.15 * (1 - car.finishTime / this.timeLimit));
    // Stopping forever in front of a hazard is no better than hitting it —
    // otherwise "park and wait" becomes a trap evolution can't escape.
    const fail = car.status === 'crashed' || car.status === 'wrong-way' || car.status === 'stalled';
    car.fitness = fit * penalty * penalty * (fail ? 0.5 : 1);
  }

  endGeneration() {
    for (const car of this.cars) {
      if (car.alive) this.kill(car, 'timeout', 'ran out of time', 'other');
    }
    const outcomes = { finished: 0, wall: 0, obstacle: 0, ped: 0, car: 0, other: 0 };
    for (const c of this.cars) outcomes[c.outcome || 'other']++;
    this.lastCars = this.cars;
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
      finished: this.finishedCount, crashes, pop: cars.length, outcomes,
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

    // Stuck detection uses the safety record on this track: small ups and downs
    // of the best car's score no longer count as progress.
    if (bestSafety > this.bestSafetyOnTrack + 2) { this.bestSafetyOnTrack = bestSafety; this.stuckGens = 0; }
    else this.stuckGens++;

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
    } else if (this.autoAdvance && this.stuckGens >= 25) {
      // Stuck on one nasty layout: try a fresh track at the same level.
      this.emit(`No new safety record for 25 generations: new track at level ${this.level}`);
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

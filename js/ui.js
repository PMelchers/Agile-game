'use strict';

const DT = 1 / 60;
const SAVE_KEY = 'autopilot-academy-v1';
const $ = id => document.getElementById(id);

const sim = new Simulation();
const renderer = new Renderer($('world'));
const chart = new SafetyChart($('chart'), $('chartTip'));
const telemetry = new Telemetry($('telemetry'));
const outcomeChart = new OutcomeChart($('outcomes'), $('outcomeTip'));
const minimap = new Minimap($('minimapCanvas'), $('mapTip'), hit => {
  if (hit.car) { pickCar(hit.car); setTab('monitor'); return; }
  const m = hit.mark;
  const car = m.gen === sim.generation && sim.cars.find(c => c.id === m.car);
  if (car) { pickCar(car); setTab('monitor'); }
  else toast(`Car ${m.car} was in generation ${m.gen}. Its brain has since been bred into the new fleet.`);
});
let showMap = true;
let frameAlpha = 1;

let paused = false;
let speed = 3;
let lastGen = sim.generation;
let lastPanel = 0;
let toastTimer = 0;
let tab = 'train';
let picked = null;          // car the viewer clicked on (null = follow the leader)
let pickedGen = 0;
let tool = null;            // obstacle kind being placed, 'erase', or null
let objSize = 10;
let ghost = null;
let lastEventsKey = '';
let lastMonitor = 0;

// ---------------------------------------------------------------- persistence
function save() {
  try {
    const data = {
      level: sim.level, bonus: sim.bonus, generation: sim.generation, trackSeed: sim.trackSeed,
      history: sim.history.slice(-400), log: sim.log.slice(0, 40),
      bestSafetyOnLevel: sim.bestSafetyOnLevel,
      custom: sim.custom, tab, speed, showMap, sensors: NUM_RAYS,
      settings: {
        popSize: sim.popSize, mutRate: sim.mutRate, mutStrength: sim.mutStrength,
        autoAdvance: sim.autoAdvance, advanceThreshold: sim.advanceThreshold, newTrackEachGen: sim.newTrackEachGen,
        learnOn: sim.learnOn, learnRate: sim.learnRate,
      },
      champion: sim.champion && { brain: sim.champion.brain.toJSON(), safety: sim.champion.safety, level: sim.champion.level, gen: sim.champion.gen },
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) { /* storage unavailable — progress just won't persist */ }
}

function load() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { data = null; }
  if (!data) return false;
  try {
    Object.assign(sim, data.settings || {});
    sim.level = Math.max(1, data.level | 0);
    for (const f of FACTORS) sim.bonus[f.key] = (data.bonus && data.bonus[f.key]) | 0;
    sim.trackSeed = data.trackSeed >>> 0;
    sim.generation = Math.max(1, data.generation | 0);
    sim.history = Array.isArray(data.history) ? data.history : [];
    sim.log = Array.isArray(data.log) ? data.log : [];
    sim.custom = Array.isArray(data.custom) ? data.custom.filter(c => PLACEABLE[c.kind] && Number.isFinite(c.i) && Number.isFinite(c.off)) : [];
    sim.customSeed = sim.trackSeed;
    if (data.tab) tab = data.tab;
    if (data.speed === 'max' || Number.isFinite(data.speed)) speed = data.speed;
    if (typeof data.showMap === 'boolean') showMap = data.showMap;
    if (data.sensors) setSensorCount(data.sensors);
    sim.buildWorld();
    sim.bestSafetyOnLevel = data.bestSafetyOnLevel || 0;
    if (data.champion) {
      const brain = adaptBrain(NeuralNet.fromJSON(data.champion.brain), data.sensors);
      sim.champion = { brain, safety: data.champion.safety, level: data.champion.level, gen: data.champion.gen };
      sim.seedFrom(brain);
    } else {
      sim.resetBrains();
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------------- UI setup
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
sim.onEvent = msg => { toast(msg); renderLog(); };

// Speed is a real-time multiplier: 1× = real time, 0.1× = slow motion,
// 'max' = as many physics steps as the CPU can fit into each frame.
const SPEED_MIN = 0.1, SPEED_MAX = 200;
const LOG_MIN = Math.log10(SPEED_MIN), LOG_SPAN = Math.log10(SPEED_MAX) - LOG_MIN;
const speedToSlider = v => Math.round(((Math.log10(v) - LOG_MIN) / LOG_SPAN) * 1000);
const sliderToSpeed = x => {
  const v = Math.pow(10, LOG_MIN + (x / 1000) * LOG_SPAN);
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v);     // friendly steps: 0.1, 2.5, 40, 150…
};
let stepAcc = 0;
let stepsThisSecond = 0, secondStart = performance.now(), realSpeed = 0;

function setSpeed(s) {
  if (s !== 'max') s = clamp(+s || 1, SPEED_MIN, SPEED_MAX);
  speed = s;
  stepAcc = 0;
  $('speedReal').hidden = true;                         // re-measured over the next second
  stepsThisSecond = 0; secondStart = performance.now();
  for (const b of $('speedSeg').querySelectorAll('button')) b.classList.toggle('on', String(s) === b.dataset.speed);
  $('speedRange').value = s === 'max' ? 1000 : speedToSlider(s);
  if (document.activeElement !== $('speedNum')) $('speedNum').value = s === 'max' ? '' : s;
  $('speedNum').placeholder = s === 'max' ? 'max' : '';
  save();
}
$('speedRange').addEventListener('input', e => setSpeed(sliderToSpeed(+e.target.value)));
$('speedNum').addEventListener('change', e => { if (e.target.value !== '') setSpeed(+e.target.value); });
$('speedNum').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
function nudgeSpeed(dir) {
  const cur = speed === 'max' ? Math.max(1, realSpeed) : speed;
  setSpeed(sliderToSpeed(clamp(speedToSlider(cur) + dir * 60, 0, 1000)));
}
$('speedSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setSpeed(b.dataset.speed === 'max' ? 'max' : +b.dataset.speed);
});

function togglePause() {
  paused = !paused;
  $('btnPause').textContent = paused ? 'Play' : 'Pause';
}
$('btnPause').addEventListener('click', togglePause);

function toggleCam() {
  renderer.mode = renderer.mode === 'follow' ? 'overview' : 'follow';
  renderer.userZoom = 1;
  $('btnCam').textContent = renderer.mode === 'follow' ? 'Overview' : 'Follow leader';
}
$('btnCam').addEventListener('click', toggleCam);

function toggleSensors() {
  renderer.showSensors = !renderer.showSensors;
  $('btnSensors').setAttribute('aria-pressed', String(renderer.showSensors));
}
$('btnSensors').addEventListener('click', toggleSensors);

$('world').addEventListener('wheel', e => {
  e.preventDefault();
  renderer.userZoom = clamp(renderer.userZoom * Math.exp(-e.deltaY * 0.0015), 0.25, 5);
}, { passive: false });

function changeLevel(d) {
  const nl = Math.max(1, sim.level + d);
  if (nl === sim.level) return;
  sim.level = nl;
  sim.applyDifficulty(false);
  sim.emit(`Level set to ${nl}`);
  refreshPanel(true);
}
$('lvlUp').addEventListener('click', () => changeLevel(1));
$('lvlDown').addEventListener('click', () => changeLevel(-1));

$('autoAdv').addEventListener('change', e => { sim.autoAdvance = e.target.checked; save(); });
$('thr').addEventListener('input', e => { sim.advanceThreshold = +e.target.value; $('thrVal').textContent = e.target.value; chart.draw(sim.history, sim.advanceThreshold); save(); });
$('newEach').addEventListener('change', e => { sim.newTrackEachGen = e.target.checked; save(); });
$('btnNewTrack').addEventListener('click', () => { sim.newTrack(); refreshPanel(true); });

function bindSlider(id, key, fmt) {
  const el = $(id), out = $(id + 'Val');
  el.value = sim[key];
  out.textContent = fmt(sim[key]);
  el.addEventListener('input', () => { sim[key] = +el.value; out.textContent = fmt(sim[key]); save(); });
}

// Factor rows (built once, text refreshed). The same factor can appear in
// more than one panel, so each key keeps a list of rows.
const factorEls = {};
function buildFactors(boxId, keys) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const f of FACTORS) {
    if (keys && !keys.includes(f.key)) continue;
    const row = document.createElement('div');
    row.className = 'factor';
    row.innerHTML =
      `<div class="name">${f.name}<small></small></div>` +
      `<div class="desc"></div>` +
      `<div class="ctl"><button aria-label="Less ${f.name}">−</button><span class="lv"></span><button aria-label="More ${f.name}">+</button></div>`;
    const [minus, plus] = row.querySelectorAll('button');
    minus.addEventListener('click', () => bumpFactor(f.key, -1));
    plus.addEventListener('click', () => bumpFactor(f.key, 1));
    box.appendChild(row);
    (factorEls[f.key] || (factorEls[f.key] = [])).push({ row, tag: row.querySelector('small'), desc: row.querySelector('.desc'), lv: row.querySelector('.lv'), minus });
  }
}
function bumpFactor(key, d) {
  const lv = sim.params.f[key];
  if (d < 0 && lv <= 0) return;
  sim.bonus[key] += d;
  sim.applyDifficulty(true);
  refreshPanel(true);
  save();
}

function renderLog() {
  $('log').innerHTML = sim.log.slice(0, 20)
    .map(l => `<li><span class="g">gen ${l.gen}</span>${escapeHtml(l.msg)}</li>`).join('') ||
    '<li>Level-ups and milestones appear here.</li>';
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function stat(k, v) { return `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`; }

function refreshPanel(full) {
  const last = sim.history[sim.history.length - 1];
  $('stats').innerHTML =
    stat('Level', sim.level) +
    stat('Generation', sim.generation) +
    stat('Alive', `${sim.aliveCount}<small style="font-size:12px;color:var(--text-muted)">/${sim.cars.length}</small>`) +
    stat('Best safety', last ? last.best.toFixed(0) : '–') +
    stat('Fleet safety', last ? last.avg.toFixed(0) : '–') +
    stat('Level record', sim.bestSafetyOnLevel ? sim.bestSafetyOnLevel.toFixed(0) : '–');
  const lc = $('learnChip');
  lc.className = 'chip ' + (sim.learnOn ? 'on' : 'off');
  lc.textContent = sim.learnOn ? 'Learning' : 'Off';
  $('learnStats').innerHTML =
    gauge('Mistakes this generation', sim.mistakesThisGen) +
    gauge('Safe waits this generation', sim.safeWaitsThisGen) +
    gauge('Lessons remembered', sim.memory.length);
  $('lvl').textContent = sim.level;
  for (const f of FACTORS) {
    const lv = sim.params.f[f.key], b = sim.bonus[f.key];
    for (const e of factorEls[f.key] || []) {
      e.lv.textContent = lv;
      e.row.classList.toggle('off', lv === 0);
      e.tag.textContent = b ? ` ${b > 0 ? '+' : ''}${b}` : '';
      e.desc.textContent = lv === 0 ? (sim.level <= f.unlock && b === 0 ? `unlocks after level ${f.unlock}` : 'off') : describeFactor(f.key, sim.params);
      e.minus.disabled = lv <= 0;
    }
  }
  const mine = sim.custom.length;
  $('buildCount').textContent = mine
    ? `You have placed ${mine} obstacle${mine === 1 ? '' : 's'} on this track. ${sim.obstacles.length} obstacles are on the road in total.`
    : `${sim.obstacles.length} random obstacles are on the road. You haven't placed any yet.`;
  $('boostHint').textContent = sim.boost > 1.01
    ? `Progress has stalled, so mutation is boosted ×${sim.boost.toFixed(2)} to explore new ideas.`
    : 'Half the children get small tweaks and half get bold changes.';
  if (full) {
    chart.draw(sim.history, sim.advanceThreshold);
    renderLog();
    if (tab === 'fleet') outcomeChart.draw(sim.history);
  }
}

function lapPct(c) { return clamp((c.maxProgress - START_IDX) / (sim.track.N * sim.params.laps), 0, 1) * 100; }

function refreshHud() {
  const f = focusCar();
  $('hud').innerHTML =
    `<div class="big">Generation ${sim.generation} · Level ${sim.level}</div>` +
    `<div class="sub">${sim.aliveCount} driving · ${sim.finishedCount} finished · ${sim.time.toFixed(1)}s / ${sim.timeLimit.toFixed(0)}s</div>` +
    (sim.learnOn ? `<div class="sub">Fleet has learned from ${sim.mistakesThisGen} mistake${sim.mistakesThisGen === 1 ? '' : 's'} this generation</div>` : '') +
    (f ? `<div class="sub">${picked ? `Watching car ${f.id}` : 'Leader'}: ${Math.round(f.speed)} px/s · ${lapPct(f).toFixed(0)}% of lap · ${f.alive ? 'driving' : f.cause}</div>` : '');
}

// ------------------------------------------------------- car picking & focus
function focusCar() {
  if (picked && (pickedGen !== sim.generation || !sim.cars.includes(picked))) picked = null;
  return picked || sim.leader();
}
function pickCar(car) {
  picked = car;
  pickedGen = sim.generation;
  lastEventsKey = '';
  if (renderer.mode !== 'follow') toggleCam();
  refreshMonitor(true);
}
$('btnFollowLeader').addEventListener('click', () => { picked = null; lastEventsKey = ''; refreshMonitor(true); });

// ------------------------------------------------------------------- tabs
function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $('panel-' + b.dataset.tab).hidden = !on;
  }
  if (name === 'train') chart.draw(sim.history, sim.advanceThreshold);
  if (name === 'monitor') { lastEventsKey = ''; refreshMonitor(true); }
  if (name === 'fleet') { outcomeChart.draw(sim.history); refreshFleet(); }
  if (name !== 'build' && tool) setTool(null);
  save();
}
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
document.querySelector('.tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const names = ['train', 'monitor', 'fleet', 'build'];
  const next = names[(names.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 3)) % 4];
  setTab(next);
  $('tab-' + next).focus();
});

// ------------------------------------------------------------ car monitor
const STATUS_TEXT = { driving: 'Driving', finished: 'Finished', crashed: 'Crashed', stalled: 'Stalled', 'wrong-way': 'Wrong way', timeout: 'Out of time' };
function gauge(k, v) { return `<div class="gauge"><div class="v">${v}</div><div class="k">${k}</div></div>`; }
function setBar(id, v) {
  const bar = $(id), i = bar.firstElementChild;
  const w = Math.abs(clamp(v, -1, 1)) * 50;
  i.style.left = (v < 0 ? 50 - w : 50) + '%';
  i.style.width = w + '%';
  if (id === 'barGas') bar.classList.toggle('brake', v < 0);
}

function refreshMonitor(force) {
  if (tab !== 'monitor') return;
  const c = focusCar();
  if (!c) return;
  $('monTitle').textContent = `Car ${c.id}${picked ? '' : ' (leader)'}`;
  const st = $('monStatus');
  st.className = 'chip ' + c.status;
  st.textContent = c.alive ? STATUS_TEXT.driving
    : `${STATUS_TEXT[c.status]}${c.status === 'crashed' ? ` (${c.cause.replace(/^hit (the |a |an |another )?/, '')})` : ''}`;
  $('monHint').hidden = !!picked;
  $('btnFollowLeader').hidden = !picked;
  $('monGauges').innerHTML =
    gauge(c.status === 'crashed' ? 'Impact speed' : c.alive ? 'Speed' : 'Final speed', `${Math.round(c.speed)} <small>px/s</small>`) +
    gauge('Lap done', `${lapPct(c).toFixed(0)}%`) +
    gauge('Safety so far', sim.liveSafety(c).toFixed(0)) +
    gauge('Close calls', `${c.nearMiss.toFixed(1)}s`) +
    gauge('Lessons learned', c.lessons) +
    gauge(c.alive && c.waitingFor ? 'Waiting now' : 'Safe waits', c.alive && c.waitingFor ? `${c.waitStreak.toFixed(1)}s` : c.yields);
  setBar('barSteer', c.steer);
  $('valSteer').textContent = Math.abs(c.steer) < 0.05 ? 'straight' : `${Math.round(Math.abs(c.steer) * 100)}% ${c.steer < 0 ? 'left' : 'right'}`;
  setBar('barGas', c.throttle);
  $('valGas').textContent = c.throttle >= 0 ? `gas ${Math.round(c.throttle * 100)}%` : `brake ${Math.round(-c.throttle * 100)}%`;
  drawRadar($('radar'), c, sim.params.sensorRange);
  telemetry.draw(c, sim.params.sensorRange);
  drawBrain($('brain'), c.brain);
  const key = `${sim.generation}:${c.id}:${c.events.length}`;
  if (force || key !== lastEventsKey) {
    lastEventsKey = key;
    $('monEvents').innerHTML = c.events.length
      ? c.events.slice().reverse().map(e => `<li><span class="t">${e.t.toFixed(1)}s</span><span class="${e.kind}">${escapeHtml(e.text)}</span></li>`).join('')
      : '<li><span class="t">–</span><span>Nothing notable yet: no close calls, jerky steering or hard braking.</span></li>';
  }
}

// ------------------------------------------------------------ fleet view
function legendHtml(counts, total) {
  return OUTCOMES.map(o => `<span><i class="dot" style="background:var(${o.color})"></i>${o.label} <b>${counts[o.key]}</b></span>`).join('') +
    (total != null ? `<span><i class="dot" style="background:var(--surface);outline:1px solid var(--border)"></i>Still driving <b>${total}</b></span>` : '');
}
function refreshFleet() {
  if (tab !== 'fleet') return;
  const counts = { finished: 0, wall: 0, obstacle: 0, ped: 0, car: 0, other: 0 };
  let driving = 0;
  for (const c of sim.cars) { if (c.alive) driving++; else counts[c.outcome || 'other']++; }
  const n = sim.cars.length;
  $('liveBar').innerHTML = OUTCOMES.map(o => counts[o.key]
    ? `<i style="width:${(counts[o.key] / n) * 100}%;background:var(${o.color})" title="${o.label}: ${counts[o.key]}"></i>` : '').join('');
  $('liveLegend').innerHTML = legendHtml(counts, driving);

  const ranked = sim.cars.slice().sort((a, b) => (b.alive - a.alive) || (b.progress - a.progress) || (b.maxProgress - a.maxProgress));
  const f = focusCar();
  const rows = ranked.slice(0, 10);
  if (f && !rows.includes(f)) rows.push(f);
  $('board').innerHTML = rows.map(c => {
    const rank = ranked.indexOf(c) + 1;
    return `<tr data-id="${c.id}" class="${c === f ? 'picked' : ''}"><td>${rank}</td><td>${c.id}</td>` +
      `<td><span class="chip ${c.status}">${c.alive ? 'Driving' : STATUS_TEXT[c.status]}</span></td>` +
      `<td>${lapPct(c).toFixed(0)}%</td><td>${c.alive ? Math.round(c.speed) : '–'}</td>` +
      `<td>${c.nearMiss.toFixed(1)}s</td><td>${sim.liveSafety(c).toFixed(0)}</td></tr>`;
  }).join('');
}
$('board').addEventListener('pointerdown', e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const car = sim.cars.find(c => c.id === +tr.dataset.id);
  if (car) { pickCar(car); setTab('monitor'); }
});
$('outcomeLegend').innerHTML = OUTCOMES.map(o => `<span><i class="dot" style="background:var(${o.color})"></i>${o.label}</span>`).join('');

// ------------------------------------------------------------ obstacle tools
const TOOL_KINDS = [...Object.keys(PLACEABLE), 'erase'];
function buildTools() {
  const box = $('tools');
  box.innerHTML = '';
  for (const kind of TOOL_KINDS) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.dataset.kind = kind;
    const label = kind === 'erase' ? 'Eraser' : PLACEABLE[kind].label;
    const hint = kind === 'erase' ? 'click to remove' : PLACEABLE[kind].hint;
    b.innerHTML = `<canvas width="68" height="48"></canvas><span>${label}</span><small>${hint}</small>`;
    b.addEventListener('click', () => setTool(tool === kind ? null : kind));
    box.appendChild(b);
    const ctx = b.querySelector('canvas').getContext('2d');
    ctx.scale(2, 2);
    if (kind === 'erase') {
      ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(11, 6); ctx.lineTo(23, 18); ctx.moveTo(23, 6); ctx.lineTo(11, 18); ctx.stroke();
    } else {
      ctx.fillStyle = '#44474d'; ctx.fillRect(0, 2, 34, 20);
      const o = previewObstacle(kind, 17, 12);
      if (o.type === 'cone' || o.type === 'rock') o.r = Math.min(o.r, 9);
      renderer.drawObstacle(o, ctx);
    }
  }
}
function previewObstacle(kind, x, y) {
  const type = kind === 'slow' ? 'traffic' : kind;
  const r = kind === 'cone' || kind === 'rock' ? objSize : kind === 'ped' ? 5 : 9;
  return { type, x, y, r, h: 0, hue: 45 };
}
function setTool(kind) {
  tool = kind;
  ghost = null;
  for (const b of $('tools').querySelectorAll('.tool')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  $('btnBuild').setAttribute('aria-pressed', String(!!kind));
  document.querySelector('.stage').classList.toggle('building', !!kind);
  const banner = $('buildBanner');
  banner.hidden = !kind;
  if (kind) banner.textContent = kind === 'erase'
    ? 'Eraser: click an obstacle to remove it · Esc to stop'
    : `Placing: ${PLACEABLE[kind].label.toLowerCase()} · click the road · Esc to stop`;
}
$('btnBuild').addEventListener('click', () => {
  if (tool) { setTool(null); return; }
  setTab('build');
  setTool('cone');
});
$('objSize').addEventListener('input', e => { objSize = +e.target.value; $('objSizeVal').textContent = objSize + ' px'; });
$('btnClearMine').addEventListener('click', () => { sim.clearCustomObstacles(); refreshPanel(false); save(); toast('Removed your obstacles.'); });
$('btnClearAll').addEventListener('click', () => { sim.clearAllObstacles(); refreshPanel(false); save(); toast('The road is clear until the track or difficulty changes.'); });

// ------------------------------------------------------------ minimap
function toggleMap(force) {
  showMap = typeof force === 'boolean' ? force : !showMap;
  $('minimap').hidden = !showMap;
  $('btnMap').setAttribute('aria-pressed', String(showMap));
  save();
}
$('btnMap').addEventListener('click', () => toggleMap());
$('mapLegend').innerHTML = OUTCOMES.filter(o => o.key !== 'finished').map(o =>
  `<span><b style="color:var(${o.color})">✕</b>${{ wall: 'Barrier', obstacle: 'Obstacle', ped: 'Pedestrian', car: 'Car', other: 'Stalled' }[o.key]}</span>`).join('') +
  '<span><b style="color:#78beff">■</b>Driving</span>';

// ------------------------------------------------------------ canvas input
function canvasPoint(e) {
  const r = $('world').getBoundingClientRect();
  return renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
}
function nearestCar(p) {
  let best = null, bd = (24 / renderer.cam.zoom) ** 2 + 400;
  for (const c of sim.cars) {
    if (!c.alive && c.status !== 'finished') continue;
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
$('world').addEventListener('pointermove', e => {
  const p = canvasPoint(e);
  if (!tool) {
    $('world').style.cursor = nearestCar(p) ? 'pointer' : '';
    return;
  }
  if (tool === 'erase') {
    const hit = sim.obstacles.some(o => Math.hypot(o.x - p.x, o.y - p.y) - o.r < 12);
    ghost = { kind: 'erase', x: p.x, y: p.y, ok: hit };
    return;
  }
  const tr = sim.track;
  let best = 0, bd = Infinity;
  for (let k = 0; k < tr.N; k += 2) {
    const d = (p.x - tr.x[k]) ** 2 + (p.y - tr.y[k]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  const off = (p.x - tr.x[best]) * tr.nx[best] + (p.y - tr.y[best]) * tr.ny[best];
  const ok = Math.abs(off) <= tr.hw + 2 && Math.min(best, tr.N - best) >= 10;
  const o = previewObstacle(tool, p.x, p.y);
  o.h = tr.ang[best];
  ghost = { kind: tool, x: p.x, y: p.y, ok, o };
});
$('world').addEventListener('pointerleave', () => { ghost = null; });
let downAt = null;
$('world').addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
$('world').addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) { downAt = null; return; }
  downAt = null;
  const p = canvasPoint(e);
  if (tool === 'erase') {
    const o = sim.removeObstacleAt(p.x, p.y, 12);
    if (o) { refreshPanel(false); save(); } else toast('Nothing to remove there. Click right on an obstacle.');
  } else if (tool) {
    const res = sim.placeObstacle(tool, p.x, p.y, objSize);
    if (res === 'ok') { refreshPanel(false); save(); }
    else toast(res === 'start' ? 'Keep the start line clear so the cars can set off.' : 'Place obstacles on the road, not the grass.');
  } else {
    const car = nearestCar(p);
    if (car) { pickCar(car); if (tab !== 'monitor') setTab('monitor'); }
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePause(); }
  else if (k === 'c') toggleCam();
  else if (k === 's') toggleSensors();
  else if (k === 'n') { sim.newTrack(); refreshPanel(true); }
  else if (k === 'b') $('btnBuild').click();
  else if (k === 'm') toggleMap();
  else if (k === 'escape') { if (tool) setTool(null); else if (picked) { picked = null; lastEventsKey = ''; } }
  else if ('12345'.includes(k) && k.length === 1) setSpeed([1, 3, 10, 30, 'max'][+k - 1]);
  else if (k === '+' || k === '=') nudgeSpeed(1);
  else if (k === '-' || k === '_') nudgeSpeed(-1);
});

// Export copies the brain to the clipboard (works everywhere) and also offers a
// file download where the browser allows one.
$('btnExport').addEventListener('click', () => {
  const brain = sim.champion ? sim.champion.brain : sim.leader().brain;
  const json = JSON.stringify({ app: 'autopilot-academy', level: sim.level, sensors: NUM_RAYS, safety: sim.champion ? sim.champion.safety : null, brain: brain.toJSON() });
  const done = ok => toast(ok ? 'Brain copied. Paste it anywhere on this page to import it later.' : 'Brain saved as a file.');
  try {
    navigator.clipboard.writeText(json).then(() => done(true), () => done(false));
  } catch (e) { done(false); }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `autopilot-brain-level${sim.level}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { /* downloads blocked — the clipboard copy still works */ }
});

function importBrain(text) {
  try {
    const obj = JSON.parse(text);
    const brain = adaptBrain(NeuralNet.fromJSON(obj.brain || obj), obj.sensors);
    sim.champion = { brain, safety: obj.safety || 0, level: sim.level, gen: sim.generation };
    sim.seedFrom(brain);
    sim.emit('Imported a brain and bred a new fleet from it');
    save();
  } catch (err) {
    toast('Could not import: ' + err.message);
  }
}

$('fileImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importBrain(await file.text());
});

document.addEventListener('paste', e => {
  if (e.target.matches && e.target.matches('input, textarea')) return;
  const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
  if (text.includes('"sizes"')) { e.preventDefault(); importBrain(text); }
});

// Two-step confirmation built into the button (no browser pop-up needed).
let resetArmed = 0;
$('learnOn').addEventListener('change', e => { sim.learnOn = e.target.checked; refreshPanel(false); save(); });
$('btnForgetLessons').addEventListener('click', () => { sim.memory = []; refreshPanel(false); toast('Saved lessons forgotten. The brains keep what they already learned.'); });

$('btnResetBrains').addEventListener('click', () => {
  const btn = $('btnResetBrains');
  if (!resetArmed) {
    btn.textContent = 'Click again to erase all progress';
    resetArmed = setTimeout(() => { resetArmed = 0; btn.textContent = 'Forget everything'; }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  btn.textContent = 'Forget everything';
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  sim.level = 1;
  for (const f of FACTORS) sim.bonus[f.key] = 0;
  sim.history = []; sim.log = []; sim.generation = 1; sim.bestSafetyOnLevel = 0; sim.memory = [];
  sim.trackSeed = Math.floor(Math.random() * 1e9);
  sim.buildWorld();
  sim.resetBrains();
  refreshPanel(true);
  toast('Progress erased. Starting fresh at level 1.');
});

window.addEventListener('resize', () => {
  renderer.resize();
  chart.draw(sim.history, sim.advanceThreshold);
  if (tab === 'fleet') outcomeChart.draw(sim.history);
});

// ------------------------------------------------------------------ main loop
const restored = load();
buildFactors('factors');
buildFactors('buildFactors', ['cones', 'peds', 'traffic']);
$('objSizeVal').textContent = objSize + ' px';
buildTools();
$('autoAdv').checked = sim.autoAdvance;
$('newEach').checked = sim.newTrackEachGen;
$('thr').value = sim.advanceThreshold;
$('thrVal').textContent = sim.advanceThreshold;
bindSlider('pop', 'popSize', v => v);
bindSlider('mr', 'mutRate', v => (+v).toFixed(2));
bindSlider('ms', 'mutStrength', v => (+v).toFixed(2));
bindSlider('lr', 'learnRate', v => (+v).toFixed(3));
$('sens').value = NUM_RAYS;
$('sensVal').textContent = NUM_RAYS;
$('sens').addEventListener('input', e => { $('sensVal').textContent = e.target.value; });
$('sens').addEventListener('change', e => {
  if (sim.setSensors(+e.target.value)) {
    picked = null;
    refreshPanel(true);
    save();
    toast(`Every car now has ${NUM_RAYS} sensor lines. Their brains were adapted, so they keep what they learned.`);
  }
});
$('learnOn').checked = sim.learnOn;
setSpeed(speed);
if (!restored && document.querySelector('.stage').getBoundingClientRect().width < 600) showMap = false;
toggleMap(showMap);
refreshPanel(true);
setTab(['train', 'monitor', 'fleet', 'build'].includes(tab) ? tab : 'train');
if (restored) toast(`Welcome back: resuming level ${sim.level}, generation ${sim.generation}`);

let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    const start = performance.now();
    let steps = 0;
    if (speed === 'max') {
      do { sim.step(DT); steps++; } while (performance.now() - start < 14);
    } else {
      // Frame-rate independent: advance by real elapsed time × speed.
      stepAcc += (dt * speed) / DT;
      while (stepAcc >= 1) {
        sim.step(DT); steps++; stepAcc--;
        if (performance.now() - start > 20) { stepAcc = 0; break; }   // CPU can't keep up: don't spiral
      }
    }
    stepsThisSecond += steps;
  }
  if (now - secondStart >= 1000) {
    realSpeed = (stepsThisSecond * DT) / ((now - secondStart) / 1000);
    stepsThisSecond = 0; secondStart = now;
    const out = $('speedReal');
    const lagging = !paused && (speed === 'max' || realSpeed < speed * 0.85);
    out.hidden = !lagging;
    if (lagging) out.textContent = speed === 'max' ? `≈${realSpeed.toFixed(0)}×` : `running at ${realSpeed.toFixed(realSpeed < 10 ? 1 : 0)}× (CPU limit)`;
  }
  if (sim.generation !== lastGen) {
    lastGen = sim.generation;
    refreshPanel(true);
    save();
  }
  if (!paused) frameAlpha = speed === 'max' ? 1 : clamp(stepAcc, 0, 1);
  const focus = focusCar();
  renderer.draw(sim, dt, focus, !!picked, ghost, frameAlpha);
  if (showMap) {
    const st = document.querySelector('.stage').getBoundingClientRect();
    minimap.draw(sim, renderer, focus, Math.min(230, st.width * 0.32), Math.min(230, st.height * 0.42));
  }
  refreshHud();
  if (now - lastMonitor > 100) {
    lastMonitor = now;
    refreshMonitor(false);
  }
  if (now - lastPanel > 300) {
    lastPanel = now;
    refreshPanel(false);
    refreshFleet();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

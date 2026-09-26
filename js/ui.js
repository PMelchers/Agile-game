'use strict';

const DT = 1 / 60;
const SAVE_KEY = 'autopilot-academy-v1';
const $ = id => document.getElementById(id);

const sim = new Simulation();
const renderer = new Renderer($('world'));
const chart = new SafetyChart($('chart'), $('chartTip'));

let paused = false;
let speed = 3;
let lastGen = sim.generation;
let lastPanel = 0;
let toastTimer = 0;

// ---------------------------------------------------------------- persistence
function save() {
  try {
    const data = {
      level: sim.level, bonus: sim.bonus, generation: sim.generation, trackSeed: sim.trackSeed,
      history: sim.history.slice(-400), log: sim.log.slice(0, 40),
      bestSafetyOnLevel: sim.bestSafetyOnLevel,
      settings: {
        popSize: sim.popSize, mutRate: sim.mutRate, mutStrength: sim.mutStrength,
        autoAdvance: sim.autoAdvance, advanceThreshold: sim.advanceThreshold, newTrackEachGen: sim.newTrackEachGen,
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
    sim.buildWorld();
    sim.bestSafetyOnLevel = data.bestSafetyOnLevel || 0;
    if (data.champion) {
      const brain = NeuralNet.fromJSON(data.champion.brain);
      if (brain.sizes.join() !== NET_SHAPE.join()) throw new Error('shape');
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

function setSpeed(s) {
  speed = s;
  for (const b of $('speedSeg').querySelectorAll('button')) b.classList.toggle('on', String(s) === b.dataset.speed);
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

// Factor rows (built once, text refreshed)
const factorEls = {};
function buildFactors() {
  const box = $('factors');
  box.innerHTML = '';
  for (const f of FACTORS) {
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
    factorEls[f.key] = { row, tag: row.querySelector('small'), desc: row.querySelector('.desc'), lv: row.querySelector('.lv'), minus };
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
  $('lvl').textContent = sim.level;
  for (const f of FACTORS) {
    const e = factorEls[f.key], lv = sim.params.f[f.key], b = sim.bonus[f.key];
    e.lv.textContent = lv;
    e.row.classList.toggle('off', lv === 0);
    e.tag.textContent = b ? ` ${b > 0 ? '+' : ''}${b}` : '';
    e.desc.textContent = lv === 0 ? (sim.level <= f.unlock && b === 0 ? `unlocks after level ${f.unlock}` : 'off') : describeFactor(f.key, sim.params);
    e.minus.disabled = lv <= 0;
  }
  $('boostHint').textContent = sim.boost > 1.01
    ? `Progress has stalled, so mutation is boosted ×${sim.boost.toFixed(2)} to explore new ideas.`
    : 'Half the children get small tweaks and half get bold changes.';
  if (full) { chart.draw(sim.history, sim.advanceThreshold); renderLog(); }
}

function refreshHud() {
  const lead = sim.leader();
  const pct = lead ? clamp((lead.maxProgress - START_IDX) / (sim.track.N * sim.params.laps), 0, 1) * 100 : 0;
  $('hud').innerHTML =
    `<div class="big">Generation ${sim.generation} · Level ${sim.level}</div>` +
    `<div class="sub">${sim.aliveCount} driving · ${sim.finishedCount} finished · ${sim.time.toFixed(1)}s / ${sim.timeLimit.toFixed(0)}s</div>` +
    (lead ? `<div class="sub">Leader: ${Math.round(lead.speed)} px/s · ${pct.toFixed(0)}% of lap · ${lead.alive ? 'driving' : lead.cause}</div>` : '');
}

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePause(); }
  else if (k === 'c') toggleCam();
  else if (k === 's') toggleSensors();
  else if (k === 'n') { sim.newTrack(); refreshPanel(true); }
  else if ('12345'.includes(k) && k.length === 1) setSpeed([1, 3, 10, 30, 'max'][+k - 1]);
});

$('btnExport').addEventListener('click', () => {
  const brain = sim.champion ? sim.champion.brain : sim.leader().brain;
  const blob = new Blob([JSON.stringify({ app: 'autopilot-academy', level: sim.level, safety: sim.champion ? sim.champion.safety : null, brain: brain.toJSON() })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `autopilot-brain-level${sim.level}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('fileImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const brain = NeuralNet.fromJSON(obj.brain || obj);
    if (brain.sizes.join() !== NET_SHAPE.join()) throw new Error('This brain has a different network shape.');
    sim.champion = { brain, safety: obj.safety || 0, level: sim.level, gen: sim.generation };
    sim.seedFrom(brain);
    sim.emit('Imported a brain and bred a new fleet from it');
    save();
  } catch (err) {
    toast('Could not import: ' + err.message);
  }
});

$('btnResetBrains').addEventListener('click', () => {
  if (!confirm('Erase all learned driving skill, history and saved progress, and start again from level 1?')) return;
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  sim.level = 1;
  for (const f of FACTORS) sim.bonus[f.key] = 0;
  sim.history = []; sim.log = []; sim.generation = 1; sim.bestSafetyOnLevel = 0;
  sim.trackSeed = Math.floor(Math.random() * 1e9);
  sim.buildWorld();
  sim.resetBrains();
  refreshPanel(true);
});

window.addEventListener('resize', () => { renderer.resize(); chart.draw(sim.history, sim.advanceThreshold); });

// ------------------------------------------------------------------ main loop
const restored = load();
buildFactors();
$('autoAdv').checked = sim.autoAdvance;
$('newEach').checked = sim.newTrackEachGen;
$('thr').value = sim.advanceThreshold;
$('thrVal').textContent = sim.advanceThreshold;
bindSlider('pop', 'popSize', v => v);
bindSlider('mr', 'mutRate', v => (+v).toFixed(2));
bindSlider('ms', 'mutStrength', v => (+v).toFixed(2));
setSpeed(speed);
refreshPanel(true);
if (restored) toast(`Welcome back: resuming level ${sim.level}, generation ${sim.generation}`);

let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    if (speed === 'max') {
      const start = performance.now();
      do { sim.step(DT); } while (performance.now() - start < 14);
    } else {
      for (let i = 0; i < speed; i++) sim.step(DT);
    }
  }
  if (sim.generation !== lastGen) {
    lastGen = sim.generation;
    refreshPanel(true);
    save();
  }
  renderer.draw(sim, dt);
  refreshHud();
  if (now - lastPanel > 300) {
    lastPanel = now;
    refreshPanel(false);
    drawBrain($('brain'), sim.leader() && sim.leader().brain);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

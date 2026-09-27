# AutoPilot Academy

A 2D world in plain JavaScript where you train fake self-driving cars. Each car
is driven by a small neural network. After every generation the safest,
furthest-driving cars breed the next one, so the fleet learns from its crashes
and its **safety score** climbs. The difficulty has no top level.

## Run it

Open `index.html` in a browser. There's no build step and nothing to install,
and it works straight from the file system.

Progress (level, history, and the best brain so far) is saved to
`localStorage`, so you can close the tab and continue later.

## How the cars learn

Two kinds of learning work together.

**1. Every car learns from every mistake, straight away.**
Each car keeps a snapshot of the last 1.2 seconds: what its sensors saw,
what it chose, and exactly where it was. When any car crashes, stalls or has
a close call, the game rewinds to 0.9, 0.5 and 0.2 seconds before the mistake
and *replays* each moment with 15 different steering and gas/brake choices,
on the same road with the same pedestrians and traffic, using the same
physics. Whichever choice gets through safely while still making progress
becomes the lesson. (If no choice survives, a rule of thumb is used instead:
brake earlier and steer towards open space; after a stall, keep driving.)

Within a fifth of a second, every car still driving trains its own brain on
the new lessons with backpropagation, plus a few older lessons so it doesn't
forget. Up to 1,500 lessons are kept, and each new generation studies them
before it sets off. Watch for the blue ripple where a mistake happened and
the flash of every car learning from it. You can switch this off, or change
the lesson strength, on the Train tab.

**2. Evolution keeps the best brains.**
- **Sensors:** 15 distance lines by default (adjustable from 5 to 31 on the
  Train tab), fanned from −90° to +90° and packed more densely towards the
  front, plus speed, lane position, heading relative to the road, and how
  sharply the road bends ahead. Changing the number adapts every brain: each
  new line takes over the connections of the nearest old one.
- **Brain:** a feed-forward network `(sensors + 4) → 16 → 12 → 2` (tanh).
  The two outputs are steering and gas/brake.
- After each generation:
  - The top 5% of cars carry over unchanged, and the all-time safest brain
    ("champion") is always kept.
  - Parents are picked by tournament from the top 40%, then combined with
    neuron-level crossover.
  - Half the children get small tweaks and half get bold mutations. If
    progress stalls, the bold half's mutation is boosted automatically.
  - With auto level-up on, if the best car hasn't set a new safety record
    on a track for 25 generations, the fleet gets a fresh track at the same
    level.

Brains keep what they learned from mistakes when they're passed on, so
lessons build up over generations. In side-by-side tests on the same tracks,
learning from mistakes raised the whole fleet's average safety score at
generation 5 from 32–37 to 88–92 (level 2) and from 5–13 to 33–70 (level 5).

### Safety score (0–100)

```
safety = 100 × completion × exp(−(0.18·closeCalls + 0.01·harshSteering)) × outcome
```

- **completion:** the fraction of the lap driven.
- **closeCalls:** seconds spent too close to walls, obstacles or cars
  (pedestrians count double).
- **harshSteering:** jerky steering beyond a comfortable rate.
- **outcome:** 1 for finishing, 0.85 for running out of time, 0.7 for
  stalling, 0.5 for crashing or driving the wrong way.

### Waiting is allowed (and rewarded)

Stopping for a pedestrian who is crossing, or slowing behind a car, is good
driving, not stalling:

- When a pedestrian or car is within 150px ahead in the car's path and the
  car is slower than 45 px/s, it is **waiting**: the stall timer pauses, for
  up to 15 seconds of patience.
- If the car then gets past without an accident, that's a **safe wait**. It
  earns a fitness bonus, so evolution favours cars that yield, and the
  moments leading up to it become a lesson every car learns from.
- Mistake replays include "stop and wait" as a choice, so when every way of
  carrying on would have crashed, the lesson is to wait.
- Stopping with nothing moving to wait for (static cones never move) still
  counts as stalling after 5 seconds, and so does waiting past the 15-second
  patience.

The Monitor tab shows each car's safe waits (or how long it has been waiting
right now), and the Train tab counts safe waits per generation.

Fitness, which evolution optimises, uses the same terms, so the cars that
survive are the ones that drive safely.

## Endless difficulty

There's one global **level**, and each of nine hazards can also be raised on
its own with the `+`/`−` buttons. You can stack them in any combination.

| Hazard | What gets harder |
|---|---|
| Curvy roads | more and sharper bends |
| Narrow lanes | the road gets thinner |
| Road obstacles | more cones and barriers |
| Pedestrians | more people crossing, and faster |
| Traffic | slower cars to overtake, then oncoming traffic |
| Fog | the sensors see less far |
| Sensor noise | the sensor readings jitter |
| Slippery roads | less grip, so the car slides |
| Time pressure | a higher minimum average speed |

Hazards unlock one after another as the level rises. Hazards are laid out
fairly: none within 700px of the start line, at least 170px between hazards,
and every cone leaves a lane wide enough to pass without a close call. The track gets longer
every level, and each hazard's intensity keeps rising toward a limit it never
quite reaches. That means every level is harder than the one before, but none
is impossible.

With **auto level-up** on, the world moves to the next level (on a brand-new
track) once the best car finishes the lap with a safety score at or above the
pass mark (75 by default, and you can change it).

## Put your own obstacles on the road

Open the **Obstacles** tab (or press **B**), pick an obstacle, and click the road:

| Obstacle | Behaviour |
|---|---|
| Cone | small and static, with an adjustable size |
| Rock | big and static, with an adjustable size |
| Parked car | static, blocks part of a lane |
| Pedestrian | crosses the road back and forth |
| Slow car | drives the lap slowly, so the fleet has to overtake it |
| Eraser | removes any obstacle you click, including random ones |

Cars react straight away. Hand-placed obstacles have a dashed ring and stay on
the track for every generation, and after a reload, until the track changes.
The same tab has quick controls for how many random hazards appear.

## Behaviour monitors

- **Monitor tab:** click any car on the road (or a leaderboard row) to watch
  it. You get its speed, lap progress, live safety score, close calls, jerky
  steering and nearest-object distance, plus bars for steering and gas/brake.
  There's a radar of what its sensors see, the last 30 seconds of speed,
  steering, gas/brake and clearance (hover to scrub), a timeline of events
  (close calls, hard braking, jerky steering, crash or finish), and its brain
  firing live.
- **Fleet tab:** how this generation's runs have ended so far, a stacked chart
  of how every recent generation ended (finished, or which kind of crash), and
  a live leaderboard.

## Map of failures

The map in the top-right corner shows the whole track, every car still
driving, and a coloured ✕ wherever a car failed: hitting the barrier, an
obstacle, a pedestrian or another car, or stalling. Marks from this
generation are bright and the previous generation's are faded, so you can see
danger spots and watch them move as the fleet learns. Hover a ✕ to see which
car failed, how, how far round the lap it got and when. Click it (or any
driving car) to open that car in the Monitor tab. Press **M** to hide the map.

## Controls

| Key | Action |
|---|---|
| Space | pause / play |
| 1–5 | speed presets (1×, 3×, 10×, 30×, max) |
| + / − | speed up / slow down (0.1× slow motion to 200×) |
| C | follow the leader / overview the whole track |
| S | show or hide sensor rays |
| N | new random track |
| B | place obstacles (Esc stops) |
| M | show or hide the map |
| Click a car | watch it in the Monitor tab |
| Mouse wheel | zoom |

You can also **export** the best brain as JSON and **import** it later, or into
someone else's world.

## Code layout

| File | Purpose |
|---|---|
| `js/util.js` | seeded RNG and math helpers |
| `js/nn.js` | neural network, mutation and crossover |
| `js/track.js` | procedural track generation, spatial grid, ray casting |
| `js/sim.js` | difficulty, obstacles, car physics, scoring, genetic algorithm |
| `js/render.js` | world renderer, safety chart, live brain view |
| `js/monitor.js` | sensor radar, telemetry strips, outcome chart |
| `js/ui.js` | controls, save/load, main loop |

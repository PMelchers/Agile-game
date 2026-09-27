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

- **Sensors:** 9 distance rays (−90° to +90°), plus speed, lane position,
  heading relative to the road, and how sharply the road bends ahead.
- **Brain:** a feed-forward network `13 → 16 → 12 → 2` (tanh). The two
  outputs are steering and gas/brake.
- **Evolution (neuroevolution / genetic algorithm):**
  - The top 5% of cars carry over unchanged, and the all-time safest brain
    ("champion") is always kept.
  - Parents are picked by tournament from the top 40%, then combined with
    neuron-level crossover.
  - Half the children get small tweaks and half get bold mutations. If
    progress stalls, the bold half's mutation is boosted automatically.
- **Mistakes are remembered:** every crash leaves a red ✕ on the road for the
  current and previous generation, so you can see where the fleet is still
  failing.

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

Hazards unlock one after another as the level rises. The track gets longer
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
  There's a radar of what its 9 sensors see, the last 30 seconds of speed,
  steering, gas/brake and clearance (hover to scrub), a timeline of events
  (close calls, hard braking, jerky steering, crash or finish), and its brain
  firing live.
- **Fleet tab:** how this generation's runs have ended so far, a stacked chart
  of how every recent generation ended (finished, or which kind of crash), and
  a live leaderboard.

## Controls

| Key | Action |
|---|---|
| Space | pause / play |
| 1–5 | simulation speed (1×, 3×, 10×, 30×, max) |
| C | follow the leader / overview the whole track |
| S | show or hide sensor rays |
| N | new random track |
| B | place obstacles (Esc stops) |
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

# Swarm3D

A Svelte 5 / SvelteKit flocking laboratory built with TypeScript and vgpu. It carries the older Swarm project's expressive species, relationships, metric feedback, response curves and scene exploration into three-dimensional worlds.

There are four volume worlds: **box, sphere, cylinder and torus**. The eight surface worlds are **sphere, plane, open cylinder, torus, Möbius strip, Klein bottle, projective plane and trefoil knot**. Volume agents move in three dimensions; surface agents have tangent velocities. On surfaces, sphere distances follow arcs, the plane uses flat XZ distance, and the cylinder uses its exact unrolled distance: circular arc length combined with axial separation. The torus surface uses its visible curved metric with numerical motion and an explicitly local midpoint distance approximation. A periodic box remains a distinct volume.

The four newest worlds use an explicit triangulated surface with transported tangent motion and a documented local neighborhood approximation. Crossing sheets retain distinct identities. See the [topology implementation](docs/TOPOLOGY.md) for its physical model, limitations and verification. Interactive exploration comes first; smooth geodesic solvers and research experiment tools remain separate work.

## Run locally

The measured desktop default is 5,000 agents with Balanced rendering. See the [performance investigation](docs/PERFORMANCE.md) for the reference device, browser measurements, density limits and reproducible experiments.

Use Node.js 24 and pnpm 12.4.2 (pinned in `package.json`). The browser needs WebGPU and a usable GPU adapter. Localhost is a secure context; a deployed site needs HTTPS. If initialization fails, the application shows the error and a retry action.

```sh
pnpm install
pnpm dev
```

Open the local URL printed by the development server. To build and preview the static application:

```sh
pnpm build
pnpm preview
```

The production build is written to `build/`.

## GitHub Pages deployment

The public application is hosted at **[neovand.github.io/swarm3d/](https://neovand.github.io/swarm3d/)**. The [deployment workflow](.github/workflows/deploy.yml) runs on pushes to `main` and can also be started manually from GitHub Actions. It installs the frozen pnpm lockfile, checks types and lint, runs server unit tests, builds the static site, and publishes the `build/` artifact to the `github-pages` environment. Repository Settings → Pages must use **GitHub Actions** as its publishing source.

The workflow reads the repository's Pages base path and passes it as `BASE_PATH` to SvelteKit. Local development and ordinary builds keep the root path. To preview the Pages build locally:

```sh
BASE_PATH=/swarm3d pnpm build
BASE_PATH=/swarm3d pnpm preview
```

Open `/swarm3d/` on the preview server. Imported assets and the simulation worker use the same deployment prefix; scene share links preserve it. Browser rendering and native GPU suites remain separate device checks because they require a usable GPU adapter.

## Explore a world

Open **Scenes** to choose a curated starting point or use **Discover** for a seeded variation. In **World**, choose the graphical **Volume / Surface** selector, then a shape and its dimensions. Eight surface icons occupy two compact rows. Plane edges can reflect or wrap; cylinder ends reflect while its circular seam preserves motion. Changing geometry starts a fresh physical run and fits the camera. Choose a species glyph to edit its independent parameters. The compact right-hand laboratory keeps one section open at a time. World guides are off by default; enable them in World when they help orient an edit.

The torus surface has **Major radius** R and **Tube radius** r, with `r≥1`, `2≤R/r≤10` and `R≤10000`. All active local query and complete obstacle force ranges remain strictly below `0.3r`. Dimension changes visibly adjust affected ranges, bodies and disks. Its symmetric midpoint classifier approximates nearby distances; the CPU audit found a largest measured distance error of 0.125% within its tested envelope, not a global error guarantee. It does not claim global shortest paths. **Ring Currents** provides an authored starting scene.

In Species, **Population** edits the selected species. **Total population** redistributes an explicit total proportionally across species with exact integer allocation, preserving surviving agents. The ordinary slider goes up to 20,000; imported larger scenes retain their actual total. Population is an explicit simulation-cost control and stays unchanged when render detail changes.

| Section      | What it changes                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Species      | Names, populations, body shapes, body size and rebel timing                                          |
| Flocking     | Alignment, cohesion, separation, perception, maximum speed, cruise target and acceleration limit     |
| Interactions | Directed species relationships and up to two metric rules per species                                |
| World        | World shape, dimensions and applicable boundaries, plus obstacle settings                            |
| Forces       | Field footprint, strength, radius, placement plane/depth and each species' response/vortex           |
| Appearance   | Five palettes, background, exposure, bloom, render detail, species trails and independent H/S/L maps |
| Dynamics     | Time scale, substep budget, noise, collisions, measurement smoothing, seed and camera rotation       |

Directed rules offer Ignore, Flee, Chase, Cohere, Align, Orbit, Follow, Guard, Scatter, Mob, Mirror and Spiral. New scenes and newly added species start with an editable **All others → Flee** fallback at strength 1, using the species' perception radius. It applies only to other species. A specific target rule overrides the fallback, including an explicit Ignore. Saved and imported configurations retain their own rules. Metric rules use a measured quantity with Neighbor, Self or Difference semantics and their own range and curve. Each color channel also has an independent source, normalization range, strength and response curve. Nine curve presets include the inherited Bowl and Bell shapes; points remain editable. Fifteen measurements include center-relative Orbit angle, signed Radial speed and Speed contrast. Static Species hue keeps the chosen base HSL; palettes apply to a metric-mapped Hue. Bodies have directional lighting, and trails retain the colors recorded along their actual past motion.

Distances use world units, speed uses units/second, acceleration uses units/second² and trail length uses seconds. **Cruise target is bounded propulsion, not a minimum speed**: it approaches the target within the same acceleration budget as steering. Contacts and interactions can temporarily slow an agent below its target. Zero disables propulsion; lowering the speed limit also clamps the cruise target. Change Cruise target in Flocking to set actual movement speed; the prominent Simulation speed control beside playback changes how quickly physical time advances. The two controls serve different purposes.

In Appearance, **Species** exposes the selected species' actual Hue, Saturation or Lightness slider. Choosing a metric activates that channel's mapping. Its Strength blends the metric response with the base channel; at 100% the metric replaces the base value. Turning mapping off restores the base color, and opening its curve editor does not enable it. Appearance edits repaint while paused and throughout a slider drag. Older trail segments retain their recorded colors.

## Tools and camera

Choose a tool explicitly from the stage toolbar:

- **Look:** drag to orbit, wheel to zoom, right-drag to pan. Shift-drag also pans; Alt-drag orbits while another tool is selected. **Reset framing** restores the scene camera; **Fit world** frames the current domain.
- **Force:** hover or drag to apply the field; pressing boosts it. In a volume, the visible work plane and signed depth offset determine placement. On a surface, the field follows the actual surface hit and intrinsic distances. The Forces section controls the footprint and each species' response.
- **Obstacle:** tap or drag to paint volume spheres/boxes or surface disks, erase nearby primitives, or tap to stamp a ring of 16 primitives. Surface disks use intrinsic distances; surface boxes are unavailable. Rings clamp at reflecting edges and wrap across periodic seams. Brush placement in a volume uses the same work plane as forces.
- **Inspect:** tap an agent to sample its state. The inspector shows its stable identity, position, velocity and local measurements, with the sample's simulation time and tick. Torus inspection also exposes the native tube θ and ring φ angles. Closing it clears selection.

On touch screens, use one finger with the chosen tool. Two fingers pan and pinch to zoom; a two-finger gesture does not apply a force or paint an obstacle. The camera remains usable while physics is paused. Pause, single-step and restart controls sit beside capture controls. Restart uses the same seed.

## Keyboard and accessibility

| Key           | Action                                            |
| ------------- | ------------------------------------------------- |
| Space         | Pause / resume                                    |
| `.`           | Advance one fixed step while paused               |
| R             | Restart the same seed                             |
| 1 / 2 / 3 / 4 | Look / Force / Obstacle / Inspect                 |
| C / F         | Reset framing / fit world                         |
| Arrow keys    | Orbit the camera                                  |
| + / −         | Zoom in / out                                     |
| L             | Show / hide the laboratory                        |
| S             | Save the current scene locally                    |
| P             | Capture a PNG                                     |
| ?             | Open the field guide                              |
| Escape        | Stop recording, close a dialog, or return to Look |

Stage shortcuts yield to focused controls and open dialogs. Curve points support arrow keys, Shift for larger changes, and Delete for removal. Native dialogs retain keyboard focus, controls have labels, and the layout responds to narrow screens and reduced-motion preferences. The welcome tour and field guide explain the same tools and shortcuts used by the application.

## Scenes and capture

The local scene library supports saving a scene or a new copy, thumbnails, renaming, deletion with Undo, and loading curated or saved scenes. Editing and scene loading also have Undo. Local saves use IndexedDB in the current browser; export JSON to keep a portable copy. Imports and share links validate the scene before applying it.

A saved or shared scene contains settings, geometry, obstacles, camera and initial seed. Loading it starts a fresh population; it is **not a checkpoint of the current particles or measurement history**. The format is Swarm3D Scene v1. Old Swarm files are not imported. A seed reproduces initialization and random streams; later chaotic trajectories can differ across GPU devices.

PNG and video capture contain the rendered canvas, without the laboratory panels. Video recording uses a browser-supported MP4 or WebM encoder; availability and format depend on the browser. Stop recording with its button or Escape. Captures download locally, then **Share capture** can open the browser's native file-sharing sheet when supported, with a download fallback. Scene sharing instead creates a URL containing the scene definition.

## Read the status correctly

**Render FPS** counts displayed frames. **Simulation time** and **tick** advance only when fixed physics steps execute. **Achieved ×** is simulated seconds divided by elapsed wall seconds; **target** is the requested time scale. A lower target deliberately slows motion. Rendering throughput and the substep budget can reduce the achieved rate further. Low stored agent speed is a physical observation, distinct from a low achieved simulation rate.

**Render detail** changes display resolution only. Fast caps the stage at one pixel per CSS pixel; Balanced uses up to 1.25; Sharp uses the device ratio up to 2. The final canvas retains its native presentation resolution. Bloom is a presentation effect. These choices keep the same population, physics and measurements.

The index retains every agent and queries all candidates within the applicable ranges, without a hidden neighbor-count cap. Dense clusters or large perception/rule radii can therefore approach quadratic work. Population alone does not establish a performance guarantee. Long visible trails and higher pixel counts also increase presentation cost.

The metric registry declares units and local estimates. Density uses volume or surface-area units as appropriate. Inspector values are sampled rather than read back every displayed frame. See the [architecture](docs/ARCHITECTURE.md) for exact measurement, geometry, contact and scheduling contracts.

## Development checks

```sh
pnpm check
pnpm lint
pnpm test:unit --run
```

These run Svelte/TypeScript diagnostics, formatting/lint checks and Vitest tests. CPU-only model/runtime tests can be selected with `pnpm test:unit --run --project server`.

Browser tests need Playwright's Chromium installation:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

The Playwright configuration builds and previews the app at port 4173, runs one worker, and enables GPU/WebGPU in Chromium. Rendering tests require a usable adapter; launching a browser does not establish that its WebGPU path works. The browser suite covers box/sphere playback and capture, scene storage/undo, tools and keyboard exclusions, paused presentation edits, unsupported-device recovery, the plane/cylinder/torus interaction and scene round-trips, real video recording with encoder fallback and Escape, keyboard curve editing with independent channels, and touchscreen tool selection/pinch/pan without painting. It also checks compact panel dimensions, editable directed and metric rules, all fifteen color sources, independent H/S/L curves, palette changes and requested-versus-achieved rates. New surface checks include physical agent picking and force response, geometry edits with fitted framing, disk/ring obstacles and saved/imported camera restoration. Torus checks also cover unsupported shape/range imports and visible range/body adjustment when its tube shrinks. `pnpm test` runs unit and browser tests together.

```sh
pnpm check:shaders
pnpm test:gpu
```

Shader checking uses vgpu's required-validation mode for every WGSL module. Native GPU checks use the installed Dawn-backed `vgpu/node` runtime and production shaders for complete neighborhoods, surface motion/transport, rendering, behaviors and metric causality. `scripts/gpu-surfaces.mjs` adds plane/cylinder ordinary and dense CPU/GPU comparisons, seam and boundary cases, all twelve behaviors, intrinsic disks/forces and depth-tested trail rendering. `scripts/gpu-torus.mjs` adds 5,184 Float32 geometry cases, 324 higher-accuracy shooting comparisons, sixteen ordinary/dense/seam measurement fixtures, actual-path motion/transport, all behaviors and torus obstacle/field/render checks. `scripts/gpu-interaction-parity.mjs` checks seventy numeric directed/metric responses against the CPU solver, while `scripts/gpu-rendering.mjs` checks shaded bodies, picked colors, palette ramps and historical RGB freeze/interpolation with capacity exceeding population. They require a usable native GPU/runtime; they are separate from browser tests. GPU checks can write diagnostic images under `.cache/`. Run GPU checks and benchmarks without another active swarm competing for the device. The documented checks have passed on the reference machine; repeat them for your device and current source. `scripts/gpu-topology.mjs` additionally checks all four triangulated worlds: local motion/transport, complete dense neighborhoods and all fifteen measurements against the CPU classifier, all twelve directed behaviors, immersed-sheet separation, sheet-attached fields/obstacles, and 120 free-motion ticks per shape. CPU tests check connectivity, Euler characteristic, orientation reversal, scene validation, packing, and history preservation; browser checks exercise all eight surface choices and seamless logo looping. The older analytic nonorientable prototypes remain research references for a different smooth solver. These results describe this tested environment rather than a hardware-independent performance guarantee.

## Design and next stages

- [Architecture](docs/ARCHITECTURE.md): scene/run state, stable identity, geometry, tick causality, complete indexing, measurements and GPU contracts.
- [Inheritance](docs/INHERITANCE.md): the older Swarm project's studied capabilities, what carries forward, and what needs redesign.
- [Roadmap](docs/ROADMAP.md): plane/cylinder, local torus and triangulated topology contracts; later smooth-surface research; later reproducibility, experiments and agent decision models.

New surfaces must establish their own physical metric, motion/transport, complete neighbor queries, picking, obstacles and history before their 3D appearance counts as support. Research claims and experiment protocols remain later work.

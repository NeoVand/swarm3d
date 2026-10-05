# Performance measurements

## Rendering and motion revision — 2026-10-04

The lit-body / historical-color build sustains **5,000 agents at 60 FPS and 1.00× simulation time** in the box and sphere on the reference Apple M4. This is a useful default, not a claim that every density or population runs in real time. The clock is capped by the 60 Hz display schedule in these measurements.

The isolated Chromium audit of this revision uses 1280×800 CSS pixels at DPR 2, three seconds of wall-time warmup, ten seconds of measurement, default trails and bloom, and duration-weighted complete telemetry intervals. Every case owns one production engine; no concurrent GPU jobs run. The final audit below includes the inactive-rule optimization; its frozen kernel measurements establish the dispatch savings separately. The default speeds are now 9.6/10.8 units/s with cruise targets at 60% of the ceiling and force 14.4 units/s². Trajectory history now includes recorded linear RGB, using 32 bytes per sample and 16 MiB at the default 8,192-slot allocation. Species controls expose cruise directly; simulation speed is a separate clock control.

| Scene       | Agents | Requested rate | Mean render FPS | Minimum interval FPS | Mean simulation / wall time |
| ----------- | -----: | -------------: | --------------: | -------------------: | --------------------------: |
| Box         |  5,000 |             1× |            60.0 |                 60.0 |                      1.000× |
| Sphere      |  5,000 |             1× |            60.0 |                 60.0 |                      1.000× |
| Box         | 10,000 |             1× |            60.0 |                 60.0 |                      1.000× |
| Sphere      | 10,000 |             1× |            49.7 |                 19.4 |                      0.997× |
| Box         | 20,000 |             1× |            33.9 |                  9.7 |                      0.903× |
| Sphere      | 20,000 |             1× |            10.5 |                  5.8 |                      0.688× |
| Compact box |  7,150 |             1× |            51.9 |                 25.2 |                      1.000× |
| Compact box |  7,150 |           2.7× |            16.8 |                  9.7 |                      1.122× |

Compact dimensions match the user's box, half-extents `[4.5,8,8.5]`, with 5,400 Jade and 1,750 Amber. This is a new seeded run using the revised defaults and four maximum substeps; it is not a controlled before/after of the user's long-running particle state or earlier three-substep configuration. As flocks concentrate, the interval frame rate can fall substantially below its average. Requesting more simulation time spends more of the available GPU time on physical ticks; it cannot promise the requested rate.

At 5k, Fast (HDR 1280×800) averaged 59.9 FPS, while Balanced (1600×1000) and Sharp (2560×1600) averaged 60.0; all achieved 1.00× simulation time. That display ceiling does not establish a percentage gain for Fast. Detail changes only rendering resolution; it cannot remove the cost of complete dense neighborhoods. All ten isolated cases completed without GPU or page errors. Raw evidence: `.cache/performance/browser-refinements.json`; reproducible command: `node scripts/browser-performance.mjs --refinements`.

### Rejected whole-cell optimization

An alternating frozen-input GPU-timestamp experiment tested rejecting cells whose clipped AABB cannot intersect the padded query sphere. Every particle output and all 15 measurements/counts were bitwise equal between variants. Gains were small or absent in most cases, while 10k sphere simulation regressed 3.015→3.473ms (15.2%). Its measurement pass improved 2.064→1.901ms, but did not offset that regression. The compact 7,150-agent box also gained nothing. **The optimization was removed from production.** `scripts/query-performance.mjs` preserves the experiment and can reconstruct the candidate from the current source; raw results are `.cache/query-performance.json`.

### Skip inactive steering work

The production simulation now checks each observer's resolved directed and metric rules once. With no active rule it skips per-neighbor rule loads and accumulation. Cross-species neighbors only need velocity transport when a rule uses them; same-species flocking still receives the transported velocity. Collision, displacement, index membership and measurements remain complete.

An alternating frozen-input GPU-timestamp comparison measured this change independently of rendering, indexing, history and scheduling. All particle outputs and IDs were bitwise identical in five timed cases plus eight small controls covering active directed rules, metric rules, mixed observers and Ignore/zero-strength precedence. The unchanged measurement shader serves as a noise control; its medians varied −8.3% to +8.2%, so paired simulation samples and consistency across cases matter.

| Distribution    | Agents | Simulation baseline → candidate | Median reduction |
| --------------- | -----: | ------------------------------: | ---------------: |
| Ordinary box    |  5,000 |                0.918 → 0.655 ms |            28.6% |
| Ordinary box    | 10,000 |                1.933 → 1.540 ms |            20.3% |
| Ordinary sphere |  5,000 |                0.885 → 0.655 ms |            25.9% |
| Ordinary sphere | 10,000 |                3.015 → 2.621 ms |            13.0% |
| Compact box     |  7,150 |                6.291 → 5.308 ms |            15.6% |

Paired median reductions were 13.2–24.9%. These are savings in the simulation dispatch on the reference device, not percentages for the entire tick or interactive FPS. The change preserves accepted neighbors and every physical rule. Reproduce with `node scripts/steering-performance.mjs`; raw samples and shader hashes are `.cache/steering-performance.json`.

### Full interface check

The compact Svelte interface also ran serially at 1280×800 CSS pixels / DPR 2, with five seconds of warmup and fifteen samples one second apart. Both 5,000-agent defaults displayed 60 FPS / 1.00× for every final sample, with no page errors. Unlike the isolated audit, these are rounded visible telemetry values. Movement controls remained open during sampling; captures additionally show the independent H/S/L controls on the authored Chromatic Flow scene. The measured panel width is 280 CSS pixels. Raw evidence: `.cache/performance/ui.json`; command: `node scripts/ui-performance.mjs` after building. `--captures` refreshes visual proof without replacing those measurement samples.

## Earlier builds — historical evidence

The following measurements precede the current lighting, history-color, behavior and speed changes. They describe the earlier workload and are retained to explain the clock/batching and torus investigations; use the current table above for the revised default, not these historical figures.

## Reference and method

- Apple M4 host, 32 GB memory; Chromium 153.0.8010.12, WebGPU adapter `apple / metal-3`, fallback adapter false. vgpu is pinned to 0.5.0.
- One engine/browser case at a time. The browser harness mounts only the production GPU engine on a canvas, without the Svelte laboratory. Full interface measurements are a separate check.
- Canvas 1280×800 CSS pixels at DPR 2; final output 2560×1600. Balanced renders its HDR stage at 1600×1000; Sharp uses 2560×1600. Camera, physics and population are unchanged by detail and effects settings.
- Isolated browser cases use two seconds of wall-time warmup, then six seconds for 5k effects/detail combinations or ten seconds for 10k/20k and compact-domain cases. Statistics use complete 500 ms callback intervals and duration-weighted means.
- Ordinary cases use seeded default populations in box half-extents `[18,12,18]` or sphere radius 16. Trails of 1.4 seconds and bloom are enabled in the isolated browser table. Compact cases use different world dimensions; they are not clustered initializations in the ordinary domain.
- Native timings use the same resolved production kernels. Compute timings include encoding, submission and queue completion averaged over a bounded batch. They measure throughput, not interactive browser latency. Native rendering uses serial frames and median GPU timestamp samples after warmup; those numbers are not directly comparable with the first exploratory burst render timing.

The benchmark is a short reference sample, not a universal capacity rating. Neighborhood occupancy changes as flocks form; GPU evolution is not promised to be bit-identical across runs.

## Production interface results

The built Svelte application ran in the full Chromium channel in headless mode on the same reference M4, at 1280×800 CSS pixels and DPR 2. Balanced rendering, trails and bloom used their defaults. Each domain had five seconds of warmup followed by 15 samples approximately one second apart, read from the rounded visible UI telemetry.

| World    | Agents | Mean visible FPS | Minimum visible FPS | Mean simulated / wall time |
| -------- | -----: | ---------------: | ------------------: | -------------------------: |
| Box      |  5,000 |             60.0 |                60.0 |                      1.00× |
| Sphere   |  5,000 |             60.0 |                60.0 |                      1.00× |
| Plane    |  5,000 |             60.0 |                60.0 |                      1.00× |
| Cylinder |  5,000 |             60.0 |                60.0 |                      1.00× |
| Torus    |  5,000 |             60.0 |                60.0 |                      1.00× |

These are arithmetic means of rounded display values from a short sample. They confirm the complete interface sustained the default exploration loop during this check; they do not establish exact GPU headroom or a percentage improvement. The isolated engine and native timings below use different methods and remain separate measurements.

Plane and cylinder were measured in a later serial run using `--surfaces`, retaining the earlier box/sphere result files. Plane half-extents were `[18,18]` with reflecting edges; cylinder radius was 12 and half-height 14. The interface kept default trails and bloom. Earlier captures were taken after pausing, so their low idle FPS is not the measured running frame rate. The capture script now also saves a running image before pausing.

The Stage 3B build rechecked the box and sphere at 60 FPS/1.00×, replacing the earlier sphere's rounded 59.3 FPS sample in this current interface table. Torus uses the authored **Ring Currents** scene at `R=20`, `r=8`, local ranges 2.2, trails 2.6 seconds, Balanced detail and bloom. Its cruise target and directed rules are authored scene choices, so it is a separate workload rather than a matched-physics dimension comparison.

## Isolated browser results after clock correction

| Population | Box render FPS | Box simulated / wall time | Sphere render FPS | Sphere simulated / wall time |
| ---------- | -------------: | ------------------------: | ----------------: | ---------------------------: |
| 5,000      |           60.0 |                    1.000× |              60.0 |                       1.000× |
| 10,000     |           60.0 |                    1.000× |              58.5 |                       0.998× |
| 20,000     |           29.1 |                    0.946× |              10.1 |                       0.662× |

All 22 isolated browser cases completed without GPU or page errors. The 5k effects matrix is limited by the 60 Hz frame clock, so it cannot establish the exact GPU savings of turning off an effect. Sharp 5k and effects-off cases also remained near the frame ceiling, with occasional lower sampling intervals. Compact 1k domains achieved 57.9 FPS / 0.998× in the box and 60.0 FPS / 1.000× on the sphere.

At 20k, catching up physics consumes drawing time: the corrected clock prioritizes bounded physical advancement, up to four substeps per displayed frame. The previous clock discarded elapsed time whenever the queue was occupied; its measured rates were 0.794× for the box and 0.595× for the sphere, while drawing more frames. Both rendering FPS and achieved simulation rate are now visible in the application. Time-scale settings deliberately below one remain distinguished from falling behind the requested target.

## Plane and cylinder browser extension

These isolated cases use five seconds of warmup and ten seconds of measurement, with complete 500 ms intervals and duration-weighted statistics. The dimensions above remain fixed as population increases; there is no automatic world expansion or neighbor truncation.

| Population | Plane render FPS | Plane simulated / wall time | Cylinder render FPS | Cylinder simulated / wall time |
| ---------- | ---------------: | --------------------------: | ------------------: | -----------------------------: |
| 5,000      |             60.0 |                      1.000× |                60.0 |                         1.000× |
| 10,000     |             60.0 |                      1.000× |                60.0 |                         1.000× |
| 20,000     |              8.5 |                      0.566× |                 7.3 |                         0.484× |

Both domains run a complete spatial index and intrinsic final radius filter on the GPU. The 20k cases are beyond the useful real-time envelope of these fixed-size scenes on this reference machine. Dense flock formation increases neighbor work; these results do not imply that simply adding more GPU dispatches would restore real-time motion. All six cases and both interface checks finished without GPU or page errors.

## Torus browser extension

The isolated torus uses the same Ring Currents definition as the production interface, proportionally redistributing populations to 10k and 20k without changing world dimensions or rules. Warmup is five seconds, measurement ten seconds; all three cases completed without GPU or page errors.

| Population | Torus render FPS | Torus simulated / wall time |
| ---------- | ---------------: | --------------------------: |
| 5,000      |             60.0 |                      1.000× |
| 10,000     |             60.0 |                      1.000× |
| 20,000     |             12.6 |                      0.803× |

These samples use the relation-reuse optimization below. The earlier torus build measured 9.8 FPS / 0.656× at 20k; evolving flocks can diverge from small rounding differences, so that comparison is not a controlled percentage improvement. The frozen-input experiment establishes the dispatch savings separately.

The 20k flock configuration is beyond the measured real-time envelope. The complete approximate local classifier still includes every accepted neighbor, with the declared torus geometry error and conservative broadphase. No population, interaction rule or neighborhood cap changes during overload.

## Measured torus relation reuse

Profiling found duplicate torus relation evaluation in both neighbor loops: `delta_world` obtained the displacement, then a second call obtained the distance. Production now obtains both from one relation. A frozen-input experiment compared both resolved shader variants on identical particles and a complete immutable index, alternating A/B order for twelve paired samples after three warmups. GPU pass timestamps measure the simulation and measurement dispatches separately; they exclude indexing, history, rendering and scheduling.

| Distribution | Agents | Simulation before → after | Measurement before → after |
| ------------ | -----: | ------------------------: | -------------------------: |
| Ordinary     |  5,000 |              2.5 → 1.9 ms |               2.2 → 1.6 ms |
| Ordinary     | 10,000 |              2.9 → 2.2 ms |               2.4 → 1.8 ms |
| Ordinary     | 20,000 |              6.3 → 4.8 ms |               6.4 → 4.8 ms |
| Dense        |  5,000 |             10.7 → 8.1 ms |               9.3 → 6.8 ms |
| Dense        | 10,000 |            38.7 → 29.4 ms |             33.2 → 24.2 ms |
| Dense        | 20,000 |          140.8 → 106.5 ms |            120.1 → 87.7 ms |

The measured median dispatch reductions were about 24% for simulation and 25–27% for measurement; paired tenth-percentile reductions remained positive. Driver timestamps are quantized, so approximate milliseconds are more useful than excessive decimal precision. The dense 20k fixture averaged 1,447 neighbors, with maxima of 1,868 neighbors and 657 agents per cell; none were truncated.

Metrics/counts stayed bitwise identical. Dense simulation outputs were bitwise identical; ordinary simulation's maximum Float32 rounding difference was `6.68e−6`, within the stated reference tolerance, with identity words exact. All five native suites passed after the change. This establishes a kernel improvement on the reference device, not a browser capacity percentage; the interactive tables use actual evolving flocks.

## Complete neighborhoods and density

| World  | Agents | Ordinary native tick | Dense native tick |
| ------ | -----: | -------------------: | ----------------: |
| Box    |  5,000 |              1.44 ms |          15.93 ms |
| Box    | 10,000 |              3.31 ms |          32.39 ms |
| Box    | 20,000 |              7.05 ms |         107.57 ms |
| Sphere |  5,000 |              1.43 ms |          12.99 ms |
| Sphere | 10,000 |              3.53 ms |          39.62 ms |
| Sphere | 20,000 |             10.39 ms |         140.14 ms |

Dense native cases compress seeded agents into a small cluster inside the same world: box positions are scaled to 1.5% of their spread; sphere positions are projected into a small cap. Every relevant neighbor remains present. Work approaches quadratic when nearly every agent can interact with every other agent.

Old Swarm limits baseline neighborhoods to 64 entries per cell and directed/metric neighborhoods to 32. This laboratory queries complete cells and performs a separate completed-state measurement pass. Returning to hidden cell caps would change behavior and measurements in crowded regions; the current performance limits are explicit.

## Movement was slowing independently of frame rate

With 1,000 ordinary agents and the same speed ceilings, average stored speed after 20 simulated seconds was:

| World  | Before active propulsion | With bounded cruise target |
| ------ | -----------------------: | -------------------------: |
| Box    |            0.613 units/s |              1.308 units/s |
| Sphere |            0.519 units/s |              1.332 units/s |

Alignment damps velocity toward the neighbors' mean. Old Swarm enforces an instantaneous 30% minimum speed; the new solver initially had only a maximum speed. Active cruise propulsion now approaches a species target within the shared acceleration budget. In this earlier experiment the target was 30% of maximum speed; the current default is 60%. Zero still disables it. This retains persistent motion while permitting startup, force-zero immobility and transient speeds below target. Physics uses seconds rather than per-frame acceleration.

## Changes made

- One native compute submission per coherent tick replaces eight separate submissions, or nine with history. Buffers, ownership and graphics remain in vgpu; the compute batch uses public WebGPU device/buffer handles. Each tick gets one configuration write. A GPU/reference test checks actual submission counts and complete state/metric/history results.
- Per-source searches include perception, positional contacts, enabled soft collision ranges, and effective active directed/metric rules. Explicit Ignore and zero-strength rules override fallback reach. Long-range exceptions no longer coarsen the entire spatial grid.
- Trail draw counts follow valid samples and visible species durations. The 5k default mature trail draw uses 1.29 million vertices rather than 1.89 million; disabled trails omit the draw. Historical positions remain in world space through camera and population changes.
- All stage draws share a single camera uniform buffer. Grid/history configuration is cached between scene changes. A one-block grid skips the two redundant prefix aggregation dispatches.
- Bloom uses quarter-width/height highlight extraction and filtering, then one compositing sample, replacing a 25-sample full-resolution filter. Balanced/Sharp adjusts only display resolution.
- The bounded clock retains elapsed time while the GPU queue is occupied. It never queues unbounded catch-up work, and actual queue completion limits frames in flight. Camera state and statistics continue updating during queue waits.

## Repeat the experiments

Build and measure the full production interface:

```sh
pnpm build
node scripts/ui-performance.mjs
node scripts/ui-performance.mjs --surfaces
node scripts/ui-performance.mjs --torus
```

The interface script starts a temporary production preview, runs each domain serially, and closes its browser/server on exit. It writes rounded telemetry and summary values to `.cache/performance/ui.json`, with paused captures at `.cache/performance/ui-volume-5000.png` and `.cache/performance/ui-surface-5000.png`.

Repeat the isolated and native checks separately:

```sh
node scripts/performance.mjs --matrix
node scripts/performance.mjs --unbatched
node scripts/browser-performance.mjs --matrix --crowded
node scripts/browser-performance.mjs --surfaces --matrix
node scripts/browser-performance.mjs --torus --matrix
node scripts/torus-performance.mjs
pnpm test:gpu
pnpm test:e2e
```

Run GPU experiments serially, with other Swarm canvases stopped. The browser script owns a temporary minimal server and closes its browser/server on exit. Native experiments do not start an application server. Raw results and captures are in ignored `.cache/performance/`; the scripts are the reproducible source. New native results use `native-optimized.json` or `native-unbatched.json`; browser results use `browser.json`.

The initial exploratory native JSON is retained locally as `native-baseline.json`, and the first browser clock measurements as `browser-before-clock.json`. Their methodology differences are stated above; do not use the exploratory render spans to claim a percentage improvement.

Plane/cylinder extensions write `browser-surfaces.json` and `ui-surfaces.json` plus shape-specific PNG captures, leaving the original box/sphere measurements intact.

Torus extensions write `browser-torus.json`, `ui-torus.json` and shape-specific captures. The full-interface script loads Ring Currents through the actual scene collection; it dismisses the welcome card before sampling and capture.

The frozen relation comparison writes `.cache/torus-performance.json`. It reconstructs the before/after shader variants even after production adopts the optimization; `--prepare-only` verifies those source transforms without initializing a GPU.

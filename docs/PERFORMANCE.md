# Performance measurements

## Demand-driven GPU revision — 2026-10-05

The previous build was doing expensive work that the scene did not use: it measured all 15 metrics for every agent and generated duplicate trail vertices. Production now calculates the metrics requested by active mappings/rules, runs spatially adjacent observers together where that helps, and shares trail vertices with a small index buffer. Bodies and trails remain procedural WGSL draws reading GPU storage; there are no CPU meshes or draw calls per agent. Population, physical rules, complete neighborhoods, shading, trail geometry and historical colors are preserved.

### Matched browser configurations

The baseline is commit `e6d98a76657c2dbee0bb0e2e72f6007dc47c68c8`, preserved in a separate checkout with the identical audit harness. Both runs use the Apple M4 / 32 GB reference host, Chromium 153.0.8010.12, non-fallback `apple / metal-3` WebGPU, vgpu 0.5.0, and one isolated production engine at a time. Canvas size is 1280×800 CSS pixels at DPR 2; Balanced renders the HDR stage at 1600×1000. Trails, bloom and default cross-species Flee rules are enabled. The frame schedule has a 60 Hz ceiling.

| Configuration        | Agents | Before FPS | After FPS | Before simulation / wall time | After simulation / wall time | After minimum interval FPS |
| -------------------- | -----: | ---------: | --------: | ----------------------------: | ---------------------------: | -------------------------: |
| Box                  |  5,000 |       60.0 |      60.0 |                        1.000× |                       1.000× |                       60.0 |
| Sphere               |  5,000 |       59.9 |      60.0 |                        1.000× |                       1.000× |                       60.0 |
| Box                  | 10,000 |       59.8 |      60.0 |                        1.000× |                       1.000× |                       60.0 |
| Sphere               | 10,000 |       59.6 |      59.7 |                        1.000× |                       1.000× |                       58.1 |
| Box                  | 20,000 |       40.0 |      59.5 |                        1.000× |                       1.000× |                       58.0 |
| Sphere               | 20,000 |       11.1 |      60.0 |                        0.740× |                       1.000× |                       60.0 |
| Open Water / Turning | 10,400 |       37.7 |      60.0 |                        1.000× |                       1.000× |                       60.0 |

Ordinary cases warm for ten wall-time seconds and measure for ten seconds. Open Water warms for sixty seconds and measures for ten seconds. Means are duration-weighted complete telemetry intervals, not rounded UI samples or synthetic tick throughput. All seven cases in each run completed without GPU or page errors. These are new seeded runs with matching configuration, not frozen particle snapshots; achieved simulation age differs when the baseline falls behind. Flock concentration and longer runs can still change the workload.

The Open Water case preserves the 5,700/4,700 populations, box half-extents `[18,12,18]`, perception 3.2/4, Flee rules, Amber Turning hue, both Turning lightness mappings, trails of 1.4/0.7 seconds, and camera framing. Jade retains maximum speed 3.7 and cruise 0.8 units/s; Amber retains 3.1 for both. This audit improves processing speed without changing those motion settings. The live preview was found running again after an earlier timing pass; that pass was superseded because isolation could not be established across its sample window. For the final repeat, the live stage remained paused at tick 26647 in multiple checks before, during and after sampling. The ordinary-domain results do not promise the same rate for the larger in-app viewport, other active metric mappings, or the previously running long-lived particle state. The earlier in-app scene was observed at 10–16 visible FPS with achieved simulation rates below target; that observation is separate from this controlled table.

Raw evidence is `.cache/performance/browser-audit-before.json` and `browser-audit-after.json`. Reproduce the current configuration with `node scripts/browser-performance.mjs --audit` while other Swarm canvases and GPU jobs are idle. This produces `browser-audit.json`. The harness mounts the engine without the Svelte laboratory; browser interaction tests exercise the complete application separately.

### Neighborhood-driven color configurations

A separate final-source audit keeps the same 10,400-agent Open Water physical settings and reference viewport, enables Jade Density hue at 100%, and tests Amber Turning at 75% or Alignment at 100%. Density uses range `[0,4]`; Alignment uses `[0,1]`. Turning includes the edited interior curve point `[0.6098129593,0.6387592449]`. Amber trail width is 0.045 in these cases; camera framing matches the Turning audit above. Both cases warm for sixty seconds and sample for ten, serially.

| Hue mappings        | Mean render FPS | Minimum interval FPS | Mean simulation / wall time |
| ------------------- | --------------: | -------------------: | --------------------------: |
| Density / Turning   |            58.3 |                 42.6 |                      1.000× |
| Density / Alignment |            59.9 |                 58.1 |                      1.000× |

These are absolute measurements of evolved seeded runs, not a matched percentage improvement over the Turning-only audit. The earlier 26/29 FPS timing pass was superseded after isolation became uncertain. The final repeat verified the live preview paused at tick 26647 and submitting zero frames in checks throughout sampling. Density/Turning still has a 42.6 FPS minimum despite the near-ceiling average. Exact count/density traverses each accepted neighborhood; each active alignment measurement also transports/normalizes neighbor velocities. Longer-lived clusters, closer camera framing and larger stage resolutions can still slow the simulation. No universal 60 FPS guarantee follows from these samples. Reproduce with `node scripts/browser-performance.mjs --metric-audit`; raw evidence is `.cache/performance/browser-metric-audit.json`.

The live in-app viewport was also larger: about 1523×1097 CSS pixels, with a 2741×1975 canvas. Exploratory observations during source/configuration edits are not matched benchmarks: the old long-lived scene reached 10–16 visible FPS, an early refreshed Turning configuration reached 60, and later Density/Alignment configurations reached 14–26 as the swarm developed. Mapping changes and particle age differed, so these observations do not isolate either Svelte overhead or a kernel regression. The controlled audits above are the performance evidence; larger viewports and long-lived concentrated flocks remain important follow-up fixtures.

### Isolated dispatch evidence

Native experiments alternate variants against frozen particle/index/history inputs and use GPU pass timestamps. They establish which change saves work without attributing evolving browser FPS to a single kernel.

- **Requested metrics:** speed, turning and acceleration always remain available. The union of every active color mapping and metric rule determines the other required fields; selection measures all 15 fields for that stable identity. For ordinary 10k agents, a local-only measurement pass fell from 0.699 to 0.008 ms in the box and 1.644 to 0.006 ms on the sphere, reductions of 98.8% and 99.6%. These are measurement-dispatch savings, not whole-frame percentages. Neighborhood metrics retain complete queries when requested. A fixed second pipeline specializes the all-fields case, keeping its measured cost within −2.1% to +1.8% of the original across ordinary and clustered fixtures. Activation, filtering and selected-agent readbacks were checked in all five worlds; requested fields match the original within `5e-6 × max(1, abs(reference))`, with counts and validity exact.
- **Basic neighborhood specialization:** the third fixed pipeline removes unreachable covariance, centroid and radial-flow code when the scene needs only local fields, count, density, alignment and heading. Count/density-only demand skips velocity transport and normalization. Selected-agent inspection keeps the generic complete-observation path. All 215 frozen comparisons were bitwise identical, including continuing smoothing and newly activated fields with zero smoothing alpha. Density demand (mask 23) reduced index-plus-measurement from 0.709 to 0.614 ms in the ordinary 10k box and 1.421 to 1.233 ms on the sphere, about 13.3%; clustered 1k worlds improved 16.1–35.0%. Combined density/alignment demand (mask 87) improved 18.8% in ordinary 10k box/sphere and 16.8–24.7% across clustered worlds. This is one bounded dependency-family variant, not a new shader compilation for each mapping edit, and the timings exclude simulation/rendering.
- **Spatial observer order:** the simulation evaluates observers in scattered spatial-index order while writing results to their original stable slots. A one-word grid flag chooses the original order for inactive holes or cells above 256 occupants. This is an evaluation-order threshold, never a neighbor cap. Ordinary 5k/10k/20k simulation dispatches improved by 28.6%/21.7%/30.8% in the box and 35.7%/42.0%/51.4% on the sphere. Dense fallback overhead measured 0.3–0.8%; added index work was 0–0.002 ms. All 38 controls and 11 timed cases produced bitwise identical physical outputs, including all behaviors, mixed metric rules, coincident agents, inactive slots and missing metadata.
- **Contiguous query strips:** for each Y/Z row, one contiguous X range replaces the per-cell X loop; periodic seams retain two disjoint ranges in the original order. This uses the existing complete count/prefix/scatter index. All 99 controls and 20 timed fixtures retained bitwise-identical physical outputs across five worlds. Ordinary simulation dispatches improved roughly 6–18% in box/sphere/plane/cylinder and 24–30% in torus; dense sphere improved 28%. The 10,400-agent user initialization measured 1.245 → 1.114 ms, or 10.5%. These are frozen simulation dispatches, not mature browser trajectories or whole-frame percentages. Grid width and metric enumeration remain unchanged.
- **Indexed trails:** four unique vertices replace six duplicated vertex invocations per ribbon segment, using one 756-byte shared index buffer. Separate species draws use their actual history duration and contiguous particle ranges. The 10,400-agent frozen fixture with mature 1.4/0.7-second trails measured body-plus-trail rendering at 2.490 → 1.835 ms ordinarily and 3.539 → 2.753 ms clustered, reductions of 26.3% and 22.2%. These passes exclude bloom, presentation and simulation. Every output channel was bitwise identical to the original triangles, including historical RGB, live heads and independently shortened species trails. Body-only rendering measured 0.459/0.590 ms in these fixtures, so replacing lit bodies was not the main opportunity in this scene.

Reproduce the native evidence serially:

```sh
node scripts/metric-performance.mjs
node scripts/metric-performance.mjs --full-only
node scripts/metric-family-performance.mjs
node scripts/neighbor-performance.mjs --adaptive-order
node scripts/neighbor-strips.mjs
node scripts/neighbor-strips.mjs --width-matrix
node scripts/neighbor-payload-performance.mjs
node scripts/world-specialization-performance.mjs
node scripts/render-performance.mjs --representative
```

The metric script pins the original baseline commit above by default; `--baseline=<ref>` explicitly chooses another baseline. Raw samples are `.cache/metric-performance.json`, `metric-performance-full.json`, `neighbor-performance-adaptive.json`, and `render-performance-user.json`. Timings are device-specific and driver-quantized; excessive decimal precision is not meaningful. The general `scripts/performance.mjs` also exercises production metric demand, adaptive indexing and indexed species trail draws.

Half-width cells improved ordinary 20k-box combined diagnostic compute about 16–19%, but dense 10k-box work rose from 32.95 to 45.5 ms, a 38% regression. The measurement shader in that diagnostic requests all fields through its ordinary dynamic-mask variant; it is not a sparse interactive tick measurement. A 32-byte gathered hot-neighbor record also lost: corrected production-order timings include simulation, one resulting-state index/scatter/gather and measurement, and were 5.0–5.1% slower for ordinary 10k/20k boxes and 4.6% slower for a clustered 5k box. Sphere gains were only 0–3%. The record candidate passed 95 controls with four metric masks, but production keeps four-byte indices.

Other rejected experiments include whole-cell rejection, unconditional spatial ordering in dense clusters, per-neighbor velocity/rule branching, and replacement strip rendering. Complete crowded neighborhoods can still approach quadratic work. No approximation, hidden cell truncation, population reduction, or automatic physical-rule change was introduced to obtain the results. [NEIGHBOR_SEARCH.md](./NEIGHBOR_SEARCH.md) records the old project's historical algorithms, primary research, adopted changes and the next structural experiments.

A simulation-only world-kind specialization removes unused geometry paths through three fixed sphere/plane/cylinder pipelines, alongside a generic box/torus/diagnostic variant. An initial timing run was superseded after the live preview was found running again. In the final integration audit with the preview verified paused, ordinary 10k/20k sphere improved 11.5%/12.9%, dense 5k sphere 10.3%, and ordinary 5k plane/cylinder 21.3%/21.6%. These adopted variants passed bitwise comparison in all control and timed fixtures. Experimental fixed box variants improved 19.0%/21.6%, but integrated position words changed by up to `9.54e-7`; fixed torus improved 4.0%, with position/velocity changes up to `3.815e-6`. Their identities stayed exact and finite outputs passed the diagnostic envelope, but both failed strict bitwise parity and remain generic. These are frozen simulation-dispatch timings, not browser FPS. The final runtime/browser gates include the selective surface variants; no universal five-variant path is adopted.

A read-only Svelte integration audit found no playback-driven scene clone, engine remount, configuration commit, bootstrap, or compute rebinding. Statistics update at most once per 500 ms and selected inspection samples two small records at most once per 200 ms. Unchanged playback writes 288 bytes of reused configuration once per tick and once per rendered frame when there are no obstacles; it does not rewrite the entire allocated 16 KiB buffer. Camera changes stay inside the plain runtime camera. Structural population/history edits can intentionally migrate buffers; trail-duration edits crossing a stride boundary may therefore interrupt playback. Neither these edit costs nor unmeasured glass/DOM composition costs establish a UI bottleneck in the controlled GPU audits.

Validation of this revision passed 195 server unit tests, all seven native GPU suites, all 15 browser interaction tests, Svelte/TypeScript checking, formatting/lint and the production build. GPU gates include independent metric channel colors, history/head colors, selected-agent validity, coherent batching, behavior parity and complete surface neighborhoods. Browser gates exercise pause with camera movement, live color changes, species/rule edits, captures, touch, curves and scene round-trips.

## Rendering and motion revision — 2026-10-04 (historical)

This section precedes the default cross-species Flee and demand-driven GPU revisions. Its workloads and timings are retained as historical evidence; the table above describes the current audit.

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

This revision added a check of each observer's resolved directed and metric rules. With no active rule it skips per-neighbor rule loads and accumulation, including cross-species velocity transport for observers without active interactions. Same-species flocking still receives transported velocity. Collision, displacement, index membership and measurements remain complete. A later experiment branching on individual neighbor behaviors regressed ordinary cases and was rejected.

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

The following measurements precede the current lighting, history-color, behavior, speed and demand-driven GPU changes. They describe the earlier workload and are retained to explain the clock/batching and torus investigations; use the 2026-10-05 table above for the current audit.

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

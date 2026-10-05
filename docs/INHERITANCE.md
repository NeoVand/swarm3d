# What carries forward from Swarm

The source of the older project is `/Users/neo/repos/swarm`. Its README is not a complete specification. This inventory draws on the WebGPU TypeScript, every WGSL module, simulation store, topology meshes, curve/scene/UI workflows and GPU tests. Old repository documents are historical evidence, not instructions for this project.

The old embedded view is a two-dimensional chart mapped into 3D. It is not a volume simulation. Swarm3D keeps useful ideas while giving volume and surface domains separate physical meanings. There is no legacy scene import. AI agent minds, exotic surfaces and a full experiment suite remain later work.

## Core agents and behavior

| Legacy capability                                                                                                                         | Carry-forward decision                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Species with names/populations, shapes, base HSL, size, trail, alignment/cohesion/separation, perception/speed/force and cursor responses | Preserve independently per species; stable keys replace positional/numeric UI identity. Five body choices remain.                                              |
| Weighted alignment/cohesion and same-species separation                                                                                   | Preserve the behavioral distinction. Express force/speed in physical time and units; use transported neighbor velocity and intrinsic displacement on surfaces. |
| Cross-species collision avoidance independent of directed relationships                                                                   | Preserve. Ignore does not disable physical collision response.                                                                                                 |
| Exact population redistribution                                                                                                           | Preserve largest-remainder allocation. Improve resizing so surviving agents retain identity/state/history rather than resetting the flock.                     |
| Rebels, intermittently weakening conformity while leaving separation active                                                               | Preserve time-based fraction/strength/period/duration; seed selection by stable agent ID and epoch.                                                            |
| Seed-like index noise and per-frame randomness                                                                                            | Replace index/display-frame dependence with scene seed, stable ID and physical tick. Do not claim bitwise deterministic dynamics from atomic scatter.          |
| Per-species cursor attraction/repulsion/ignore, plus independent vortex                                                                   | Preserve. Place a real point/plane in volume and pick an intrinsic point on the sphere.                                                                        |

All twelve directed names carry over. Their 3D definitions are deliberate adaptations rather than numerical copies of planar perpendicular vectors:

| Name     | Retained concept and dimensional issue                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Ignore   | No directed steering; explicit Ignore overrides wildcard fallback.                                                                     |
| Flee     | Escape from target, stronger nearby.                                                                                                   |
| Chase    | Pursuit with target-velocity lead. Current surface policy leads in the observer tangent space, not an exact future-geodesic predictor. |
| Cohere   | Approach target with partial velocity influence.                                                                                       |
| Align    | Match target velocity; transport before comparison on surfaces.                                                                        |
| Orbit    | Tangential movement; volume needs an axis, surface needs handedness.                                                                   |
| Follow   | Desired trailing slot behind target velocity; replace the legacy fixed 30-pixel offset with domain units.                              |
| Guard    | Maintain a preferred fraction of interaction range.                                                                                    |
| Disperse | Repulsion with deterministic variation.                                                                                                |
| Mob      | Approach with alternating orbital component; use stable pair identity rather than storage-index parity.                                |
| Mirror   | Oppose target motion after transport.                                                                                                  |
| Spiral   | Combine radial and orbital steering; define its axis/handedness.                                                                       |

Directed rules remain asymmetric: A→B does not imply B→A. Metric rules can act on same- or other-species neighbors. Their source roles are Neighbor, Self and absolute Difference, with shorter circular difference for angular sources. Two metric rules per species remain the initial editor limit.

The legacy baseline already used bounded weighted mean displacement for cohesion (`simulate.wgsl:788`) and weighted velocity matching for alignment (`:785`); both concepts carry forward. Its normal movement also enforced a `0.3·maxSpeed` floor (`:1595–1605`) and added acceleration once per display update before applying `deltaTime·60·timeScale` to displacement (`:1588–1610`). The current model integrates acceleration in physical time. An explicit per-species `cruiseSpeed` defaults to `0.3·speed`, preserving persistent-swimming intent through bounded active propulsion. Its velocity change remains within `force·dt`; force zero cannot accelerate, and transient speeds below cruise are valid. This is not an instantaneous inherited floor. Without propulsion, a flock can physically slow toward rest while the simulation clock runs at full speed. Copying the old numeric coefficients alone would not preserve its motion.

Soft collision now acts on all agents; same-species separation remains a distinct flocking rule with a physical range. A bounded positional contact correction reduces body overlap without inflating steering velocity, and may require multiple ticks in dense configurations. These are explicit model changes. They must be included in future methods/ablation descriptions rather than described as an exact legacy baseline. See `ARCHITECTURE.md` and the shader layout contract for their limits.

Evidence: old `src/lib/shaders/simulate.wgsl` (baseline and interaction accumulation), `src/lib/webgpu/types.ts` (behavior/source enum contracts), and `src/lib/stores/simulation.ts` (allocation, species deletion and randomization).

## Measurements and programmable appearance

The legacy project has more than simple flock controls. Density, anisotropy, speed/turn-like fields, local angular/radial fields, curves and rules form an expressive programmable system. This must remain central to exploration.

| Capability                                                         | Decision                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weighted local density and 2×2 displacement moments                | Preserve local statistics, but name their formulas and units. Current density uses complete count / nominal ball measure; anisotropy uses two tangent dimensions or three volume dimensions.     |
| Six “spectral rank” fields and repeated smoothing iterations       | Preserve useful local center/flow/directional concepts as separately named metrics. The existing algorithm is local measurement plus temporal smoothing, not PageRank or global graph diffusion. |
| Independent H/S/L source, sensitivity/strength and response curves | Preserve separate mappings and sampling. Allocate distinct measurements so different H/S/L sources cannot all read one overwritten rank slot.                                                    |
| Five palettes                                                      | Preserve Chrome/Ocean/Bands/Rainbow/Mono as explicit choices.                                                                                                                                    |
| Nine editable response presets                                     | Preserve exact control points and shape-preserving cubic intervals. Bowl/Bell intentionally contain extrema. Mapping enablement is independent of opening its editor.                            |
| Metric-driven species behavior                                     | Preserve with read-only previous-completed snapshot causality.                                                                                                                                   |

Correct misleading legacy meanings rather than reproducing them under scientific labels:

- “Flow Divergence” divides own speed by the magnitude of average neighbor velocity. It is not a differential divergence operator.
- Distance/Asymmetry modes share essentially the same local-center distance computation with different scales. They are not independent structure measures.
- “Acceleration” visual mode uses speed in one path and turn-like data in another. Current acceleration is a transport-corrected finite velocity difference.
- The old turning/orientation/density visual modes sometimes use speed, heading bands, birth angle or position instead of their label's apparent physical source. Current registry descriptions govern every source.
- Angle smoothing must respect circular geometry. Temporal smoothing advances with simulation time, not render frames or a repeated iteration UI label.

See `ARCHITECTURE.md` for the exact twelve current formulas, units, circular references and instant/smoothed status. Evidence: old `rank.wgsl`, `boid.wgsl`, `trail.wgsl`, `buffers.ts` and the curve editor/store sampling functions.

## Trails, worlds and interaction

| Legacy capability                                                                 | Decision                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fifty-sample history ring, per-species lengths, taper, body-aware tail attachment | Preserve the visual concept; current history is bounded and sampled in physical time. Alpha/width/length meanings are explicit.                                                                     |
| Surface seam continuation and transformed historical velocities                   | Essential for future charts. Sphere history already uses a continuous surface; periodic-volume trails need wrapped segments.                                                                        |
| Historical color derived from stored position/velocity only                       | Preserve current bounded history honestly. A true history of density/turn/metrics requires additional storage; do not claim current trails record it.                                               |
| Orbit, zoom, pan, fit, auto-rotation and camera persistence                       | Preserve independently of paused physics. A world/camera reset must not arise from canvas resizing.                                                                                                 |
| CPU analytic/mesh picking rather than a GPU readback every cursor move            | Preserve the responsive design. Picking returns a physical point/domain location, not arbitrary screen depth.                                                                                       |
| Draw/erase disks/rings into a wall mask, including copying/eroding snapshots      | Preserve editing intent, redesign representation. Initial volume obstacles are sphere/box primitives; sphere walls are geodesic caps/compound stamps. Raster chart masks return with chart domains. |
| Visible shell/grid and depth occlusion                                            | Preserve spatial cues, with honest front/back visibility controls. The shell is rendering geometry, not the neighborhood graph.                                                                     |
| Flat/cylinder/torus/Möbius/Klein/Projective choices with optional embedding       | Preserve the valuable topological exploration as staged future domains. A flat chart preview and curved metric are explicit separate properties.                                                    |

The old metric frame compensates local surface stretch using the square root of `JᵀJ`; it clamps singular values to avoid explosive motion. Its area-log-gradient drift encourages agents toward roomier patches. These are valuable lessons about chart distortion, but the drift is not a substitute for covariant geodesic motion and the clamp does not repair a singular immersion.

Sphere comes first because analytic geometry supplies a reliable curved reference. Plane/cylinder then establish exact chart transitions. Torus follows with induced-metric motion and documented neighborhood approximation bounds. Möbius/Klein require a transported orientation state, metric-consistent seam transforms and sheet-aware picking/painting. Nearby pixels at a Klein immersion crossing must not create intrinsic neighbors. RP² later uses spherical antipodal state; the old doubly twisted flat-lattice interpretation is not copied.

Evidence: old `embed.wgsl`, `embedding.ts`, `topologyMeshes.ts`, `camera.ts`, `simulation.ts` and `trail.wgsl`. The old code itself cuts Projective Plane seam trails because its continuation does not match the displayed immersion; this is a warning to redesign the representation, not a finished geometric model.

## Discovery, scenes and everyday use

Preserve curated starting scenes, coherent random discovery, editable names/populations and immediate visual exploration. Seeded discovery varies species families and directed relationships while keeping the chosen world and presentation. It uses an exact total and keeps every result within the same validated scene contract.

The new library stores named scene definitions and separate thumbnails transactionally in IndexedDB. It supports import/export, Unicode names, URL-safe share definitions, delete and undo. It deliberately starts a new version-one format; older schema/viewport-derived wall data are not implicitly adapted. Camera and force-placement settings belong in the scene.

Preserve responsive play/pause/reset, camera exploration while paused, meaningful empty/error/loading states and useful keyboard/pointer interaction. Persistent settings and scene editing must be reversible at the UI layer. Do not inherit hidden viewport population limits, ambiguous spectral iteration names or storage-slot-based selection.

The seven inherited lab sections are Species, Flocking, Interactions, World, Forces, Appearance and Dynamics, with sticky active-species context. Separate Look/Force/Obstacle/Inspect tools resolve camera and editing conflicts; touch needs two-finger navigation and a deliberate force/obstacle gesture. Hover/click force boost, disk/ring placement and per-species vortex responses remain useful. Continuous obstacle painting is later work unless the input path explicitly supports dragging; single/compound placement must not be advertised as a brush.

Keep clean image capture, recorded video with an explicit stop indicator, native sharing and a clipboard/share-link fallback. Prefer MP4 where browser support permits it, with truthful WebM fallback. Capture controls should remain available when the lab is closed. The older guided tour had 31 steps and stale pane/key assumptions; replace it with a short native guide, a single shortcut registry, accessible modal focus, keyboard curve editing and reduced-motion support.

Expose render FPS, physical tick/time, actual real-time factor and trail memory as distinct status values. A selected individual's sampled GPU state makes observations concrete without reading back the entire flock every frame. These are interactive observation tools; they do not constitute the deferred experiment suite.

The initial curated collection is Murmuration, Open Water, Satellites, Cross Currents and Small Planet. The initial population is 5,000 pending performance measurement, rather than advertising the old 15k/60 FPS claim as current evidence.

## GPU lessons that are design requirements

The old clear/count/prefix/scatter sequence, shared GPU state, batched uploads, instancing and avoiding routine readback are useful. Its GPU-parallelism notes document practical failures, but some claims describe older implementations; compare them against code before applying them.

Known hazards to avoid:

1. Reading neighboring metric outputs within the invocation pass that writes them creates a race.
2. Ranking new positions with the old position index creates an incoherent neighborhood.
3. Fixed cell-search reach misses large per-species/custom-rule ranges.
4. Fixed 32/64-per-cell caps introduce density bias and atomic-order-dependent neighbor selection.
5. A viewport resize can outgrow a grid allocation when world size is coupled to pixels.
6. Wildcard “zero means unset” logic can overwrite explicit Ignore.
7. Requesting insufficient storage-buffer stage limits cannot make a ten-buffer shader valid.
8. Module-global device/depth resources make independent engine instances interfere.
9. Position updates that use dt while force/noise/rebel timing uses frames change behavior with display rate.
10. Reallocations/resets that leave old metrics/history behind create false first-frame observations.

Current contracts address these through complete queries, immutable snapshots, explicit rule precedence, physical-time integration, instance-owned resources, stable identity and validated scene data. New runtime tests must establish actual behavior; code structure alone is not evidence of performance or correctness.

## Verification and remaining research work

Model tests verify exact allocation and survivor IDs, deterministic initialization/discovery, strict import/version/range validation, sphere operators and free motion, all-pairs/grid agreement, more than 64 colocated neighbors, periodic duplication/ties, anisotropy cases, circular smoothing, curve interval shape preservation and scene-library undo. Real IndexedDB save/update/delete/restore was also exercised in a browser. These are foundations, not a full experiment suite.

GPU validation needs buffer/index invariants, complete large-range neighbors, old/new state causality, field parity against CPU references, domain invariants, 30/60/120-display-rate equivalence, lifecycle/reset/pause checks and representative clustered performance. Visual checks need readable body/trail density, color-source independence, depth/picking correctness and camera usability.

Later research work adds explicit experiment protocols, deterministic reduction when required, replication across seeds/adapters, measured convergence/approximation error, stored outcomes and publishable benchmarks. Later agent minds consume a read-only observation and produce a steering action through the same domain interface, with identity-linked memory. Neither is represented as implemented in this release.

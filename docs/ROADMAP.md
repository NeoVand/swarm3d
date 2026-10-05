# Swarm3D roadmap

The explorer now supports a box volume, sphere surface, plane surface, open cylinder surface and torus surface. Stages 0–2 establish the studied inheritance, domain/model contracts, GPU simulation and programmable lab; Stage 3A adds the exact flat-chart surface reference; Stage 3B adds a curved torus within an explicit local approximation envelope. Completion of that release does not establish that every later surface or a publishable experiment system already exists.

The current evidence and contracts live in [INHERITANCE.md](./INHERITANCE.md), [ARCHITECTURE.md](./ARCHITECTURE.md), the model registry/reference tests and `src/lib/gpu/shaders/layout.md`. The old project's documentation is evidence to compare with implementation, not a requirement to copy its inconsistencies. This roadmap distinguishes the validated current domains from the remaining geometric and research work.

## Current baseline and release evidence

Keep the implemented baseline explicit. Same-species alignment/cohesion use cubic distance weights. Alignment matches mean velocity; cohesion is a bounded local-displacement spring, as in the legacy baseline. Separation uses its own close-range squared kernel. An explicit cruise target supplies bounded active propulsion within the total `force·dt` velocity-change budget, with valid transient speeds below target. All-agent soft collision and a bounded positional contact correction remain separate from directed rules. The contact correction uses the immutable input snapshot and does not become a stored velocity boost. This model is not elastic particle dynamics. Physical-time integration, bounded propulsion replacing the legacy instantaneous minimum-speed floor, physical body radii and all-agent contacts distinguish it from the old numerical model.

Maintain the complete count/scan/scatter index, immutable metric snapshots, fixed integration timestep and stable identity. Document whether an observation uses stored steering velocity or actual constrained displacement. Retain named physical units, circular references, instantaneous versus smoothed fields and every declared local approximation.

The box/sphere release gate is a working exploration loop, all twelve directed behaviors, two metric rules per species, independent H/S/L response mapping, meaningful scenes/discovery, reversible editing, local scene library, capture and responsive camera/input. Evidence includes CPU geometry/all-pairs/grid checks, GPU index/measurement/reference probes, lifecycle/reset/pause/identity checks, browser interaction tests and visual review. Performance is reported against the actual adapter, scene, radii and trail configuration, with simulation/wall-time ratio separate from render FPS.

The remaining geometric and research stages should not require replacing those interfaces or introducing premature adapter scaffolding.

## Stage 3: geometric expansion

Each new domain has a native representation, physical metric, motion/transport operators, conservative broad phase, exact or declared approximate neighbor relation, picking and history representation. Rendering is a downstream map. New domain/metric or behavioral definitions are versioned model changes; old scene versions must remain explicitly readable or fail clearly rather than silently acquiring new physics.

The shared relation supplies distance, displacement/log vector and neighbor velocity transported into the observer tangent space. Behavior kernels do not average arbitrary ambient positions or compare unrelated tangent frames. Stable IDs, rule precedence, previous-snapshot causality and force limits remain unchanged.

### 3A: exact chart reference — plane and cylinder (implemented)

The bounded XZ plane has reflecting or periodic edges. The open cylinder has one periodic circular coordinate and reflecting axial ends. Cylinder arc length and axial distance define an exact flat metric. The World panel includes a reduced-motion-aware chart illustration; it explains the existing model without changing its distance definition. Sphere and box scenes remain compatible.

The current production browser suite passes eleven tests, including plane/cylinder physical picking, force response during a single paused step, dimensions and camera fitting, surface disk/ring painting and erasing, PNG capture, and save/load/import/export with retained geometry, obstacles and camera. Native `scripts/gpu-surfaces.mjs` passes complete scatter and all twelve measurement comparisons against CPU all-pairs oracles, ordinary/dense populations, periodic partial-edge/corner seams, free motion with transport-corrected derivatives, repeated boundary arithmetic, all twelve behaviors, contacts, long queries, obstacles, fields and depth-tested body/trail rendering. Existing box/sphere reference, behavior and batching probes also pass. CPU tests cover validation, physical-measure initialization, chart representatives, ray picking, index packing and seam-preserving history migration.

These release gates remain the contract for future changes:

- CPU/GPU agreement for local displacement, speed and transported vectors.
- Equivalent chart representatives return the same physical neighbor relation, including half-period ties and multiple crossings in one tick.
- Seam crossing preserves tangent velocity, rendered body orientation and directional history. A straight native trajectory wraps continuously on the displayed cylinder.
- Boundary/obstacle interaction, picking and brush positions use physical units; resizing the viewport leaves the domain unchanged.
- Complete cell-query coverage for the largest applicable rule/body radius, with wrapped-cell deduplication.

These domains provide an exact reference for chart code before adding curvature or twisted seams.

### 3B: torus with an induced metric and local midpoint classifier (implemented)

The implemented ring torus uses `ds²=r²dθ²+(R+r cos θ)²dφ²`, including its connection in speed-preserving midpoint free motion and vector transport. It requires tube radius `r≥1`, `2≤R/r≤10`, major radius `R≤10000`, and complete active interaction/obstacle reaches strictly below `0.3r`. Unsupported scene shapes/ranges fail validation; World edits adjust affected ranges and bodies visibly. The visible curved metric remains distinct from a flat periodic rectangle.

Neighbor classification uses a symmetric local midpoint approximation and exact connection transport along the chosen chart path. It does not claim global shortest geodesics. The CPU shooting audit's largest observed distance error was 0.125% in its tested envelope. A padded ambient broad phase is proven complete for this declared classifier. Numerical free motion subdivides travel and transports previous steering state along the actual integration path, so geometric curvature does not count as steering turn. Physical-area spawning, native angle inspection, contour-consistent obstacles, hole-aware picking and both history seams are implemented.

Native `scripts/gpu-torus.mjs` passes all twelve measurements and exact midpoint neighbor counts across sixteen ordinary/dense/seam fixtures, 5,184 Float32 geometry cases across shape/scale sweeps with 324 shooting comparisons, free motion, all twelve behaviors, contact/field/obstacle cases and depth/trail rendering. The eleven-test production browser suite passes picking and native-angle inspection, paused force/step, coupled dimensions and fitted framing, camera motion while paused, painting/erase, invalid imports, PNG capture and scene/framing round-trips. Tube reduction also proves visible range/body adjustment. The verification gate passes 139 CPU tests (thirteen cover private nonorientable reference prototypes), five native GPU suites, eleven browser checks, type/lint/shader checks and local visual review. Browser evidence also includes a decoded native video recording stopped with Escape, keyboard curve editing and independent mappings, and real touchscreen tool/navigation gestures. Möbius and Klein remain unsupported.

These gates remain the contract:

- Metric is positive definite throughout every permitted shape; analytic/finite-difference Jacobians agree within stated tolerance.
- Unforced motion preserves physical speed with timestep convergence. Curving around the surface does not count as true steering turn.
- Neighbor distance and transport errors satisfy declared tolerances across the entire chart, especially inner/outer rims and seams; refinement decreases error.
- Area-weighted spawning and nominal area-density measurements do not inherit chart sampling bias. Emergent flock clumping is measured separately from initialization bias.
- No hidden singular-value clamp changes the selected metric. Shape parameters causing degeneracy are rejected.
- Trails, bodies, obstacles and picked points agree with the same native/world map and physical sizing.

An area-gradient preference can be a separately named behavior, not an undocumented substitute for geometric integration. [Crane's differential geometry notes](https://www.cs.cmu.edu/~kmcrane/Projects/DDG/paper.pdf) provide the intrinsic/embedding and connection foundations used by this gate.

### 3C: Möbius strip

Private CPU reference prototypes now check immersion derivatives, metric seam laws and transported orientation bookkeeping. These are thirteen tests shared with the Klein prototype, not live world support. Motion, local log/transport accuracy and GPU/product gates remain outstanding.

Use a valid longitudinal identification `(u+L,v) ~ (u,−v)` with bounded transverse coordinate. Every seam operation transforms tangent velocity, force, body orientation, history and future directional memory using the transition derivative. Require metric consistency `g(q)=Dτᵀg(τ(q))Dτ`.

An agent's local handedness is transported as orientation-cover state. A global continuous clockwise force field cannot be assumed on a nonorientable surface. Define agent-local chirality or a localized orientable cursor patch, and describe that choice in the model.

Gate:

- One twisted circuit reverses the relation to the chart frame; two restore it. Rendered bodies/trails remain continuous through both.
- Equivalent-chart physical distances, speeds and neighbor velocity comparisons agree, including corners and repeated crossings.
- No spurious angular turn is introduced by coordinate reflection.
- The permitted width/shape envelope has a nondegenerate induced metric and a regular display map.
- The single connected physical boundary behaves consistently despite appearing as two transverse chart edges.
- Scalar fields, vector fields and orientation-dependent quantities receive the appropriate transformation; map-enabled and editor-visible state remains separate.

### 3D: Klein bottle

Use consistent quotient transitions: one twisted periodic seam and an ordinary periodic seam. The deck generators may legitimately be noncommutative. Use a checked regular immersion with an explicit induced metric, rather than a display pinch plus an invisible numerical repair.

The 3D display intersects itself. Native points on different sheets must remain distinct. Ambient proximity can serve as a conservative broad phase, but the final physical relation is intrinsic and carries the selected native representative. Chart-based broad phases may avoid excessive false candidates near crossings.

Gate:

- Crossing sheets do not become neighbors, collide or share painted walls unless their intrinsic relationship justifies it.
- Picking returns a native point/sheet; ambiguous display hits have a clear selection policy.
- All metric/orientation/history seam gates from Möbius pass under both generators and their compositions.
- Uniform physical-measure initialization, speed preservation and approximation convergence pass over the complete permitted domain.
- No surface-normal/global-clockwise assumption leaks into behavior or render orientation.

The distinction between a Klein quotient and its intersecting 3D display is established in [Hatcher's topology notes](https://pi.math.cornell.edu/~hatcher/Top/TopNotes.pdf). This is an intrinsic manifold gate, not a demand to eliminate unavoidable intersections in the picture.

### 3E: separate optional research domains

RP² should use spherical antipodal equivalence, including velocity sign changes, shorter signed representatives and its own cut-locus policy. Do not clone the old globally flat doubly twisted lattice. A square gluing can be topologically meaningful without providing a smooth flat metric at its corners. Sphere/antipodal semantics come from [Hatcher's notes](https://pi.math.cornell.edu/~hatcher/Top/TopNotes.pdf).

Generic meshes require asset topology, native connectivity, metric/transport operators and error/performance measurements. The [Vector Heat Method](https://www.cs.cmu.edu/~kmcrane/Projects/VectorHeatMethod/index.html) is a relevant primary reference for transport/log maps. It does not establish that per-agent moving queries at flock scale are cheap. Neither RP² nor generic meshes is a prerequisite for the initial volume/sphere explorer or the cylinder/torus/Möbius/Klein sequence.

## Stage 4: research and later decision models

Add research capabilities after the explorer and selected geometric domains pass their declared gates. Define questions before building a generic experiment dashboard. A compelling paper requires a named model and evidence about that model, not merely attractive footage or a large agent count.

### 4A: model study and validation protocol

Freeze and report the exact scene/model version, domain and metric, timestep, geometric approximation method/range, response curves, perception/rule/body radii, maximum/cruise speeds, force limits, contact/obstacle constraints, smoothing definitions and random initialization. Define whether outcomes measure stored steering velocity, constrained displacement or both.

Study the effects of active propulsion, displacement-spring cohesion, contact projection, species-directed rules, metric feedback and rebels through explicit ablations. Separate dimension and units: count, agents/unit² and agents/unit³ are not interchangeable. Surface coordinate-bearing fields are declared reference-dependent quantities, not rotation-invariant physical observations.

Gate:

- Reference convergence and domain invariants hold for every protocol's permitted parameters, including clustered/contact-heavy cases.
- Cruise tests cover startup from rest, force-zero immobility, acceleration limits, maximum-speed limits, tangent fallback directions and valid transient speeds below target; no instantaneous minimum-speed projection is hidden in the description.
- Contact tests measure finite/bounded corrections, true radius semantics, timestep sensitivity and residual overlap; no assumption of exact one-step nonpenetration or momentum/energy conservation is hidden in the description.
- CPU/GPU comparisons use complete neighborhoods, named tolerances and immutable snapshot causality.
- Seed replication, transient/warm-up duration, sample timing, number of runs and aggregation rules are specified before claiming an effect.
- Numerical and geometric approximation error is distinguished from variability across seeds.

The implemented model registry, CPU geometry/reference measurements and shader layout are the primary project specification. [Geomstats' sphere operators](https://geomstats.github.io/_modules/geomstats/geometry/hypersphere.html) provide an independent analytic check for the first curved domain; chart/mesh comparisons use appropriately matched references.

### 4B: reproducibility and measurements

Record code/shader/runtime versions, scene definition, seed/run generation, physical time/tick, adapter/browser information and measurements needed by the chosen protocol. Avoid attaching GPU readback or unlimited history to every interactive render frame.

Atomic scatter permits floating-point reduction-order variation. Where exact replay is required, provide a deterministic ordering/reduction mode and state its adapter/runtime scope. Otherwise report bounded reference agreement and statistical replication; do not label all long chaotic trajectories exactly reproducible.

Maintain full uint32 seed/ID/tick packing and test their high bits. Long-run clocks, epochs and counters need declared precision/wrap policies. Exhausted IDs require a new run generation; they must not alias survivors. A saved definition/share is not a simulation checkpoint. A checkpoint feature needs its own schema, histories, filter/policy state and restore invariants.

Benchmark simulation stages and presentation separately, including CPU submission overhead, actual simulation/wall-time ratio, query density and history memory. Report normal and pathological distributions. Batching inside the engine boundary is justified by measurements, without altering phase ordering.

Only then add protocol-specific run scheduling, outcome storage/export, comparative plots and publication artifacts. This is the later experiment work intentionally deferred from the current interactive UI.

### 4C: agent minds

Keep stable identity and the observation-to-steering boundary established now. A later decision policy consumes a read-only completed observation and emits an action in the appropriate volume/tangent space. Its memory is keyed by agent/run identity and transported or reset correctly under geometry transitions.

Before adding an AI policy, specify its observation budget, action cadence, latency policy, inference cost, memory lifecycle, random stream and baseline comparisons. Decide whether decisions are synchronous with physics or sampled on a slower cadence. Evaluate against the classic policy with matched sensory/rule ranges and contact constraints.

Do not implement AI adapters, model-provider configuration, an agent framework or an experiment service merely to reserve future scope. The current contracts make those choices possible later; the next work remains correct, expressive geometric exploration.

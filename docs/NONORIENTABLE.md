# Smooth nonorientable surface research contract

Möbius and Klein are now supported through the triangulated solver described in [TOPOLOGY.md](TOPOLOGY.md). This document describes a separate analytic smooth-surface solver and preserves its research gates; its proposed chart state and parameter envelopes are not the current application contract. The private [CPU prototype](../src/lib/model/nonorientable-reference.ts) and [tests](../src/lib/model/nonorientable-reference.spec.ts) establish regular immersions, seam consistency, transported orientation state, native sheet distinction and complete chart candidate queries. They do **not** yet certify free-motion integration, logarithms, parallel transport errors or native GPU performance.

The proposed first release uses an induced Möbius metric and an induced figure-eight Klein metric. A flat quotient displayed as a curved surface is a different model and must not share these world definitions. In particular, [Geomstats' Klein implementation](https://geomstats.github.io/_modules/geomstats/geometry/klein_bottle.html) supplies a figure-eight display map alongside a flat default metric; its coordinate addition and Euclidean log are not an induced-metric physics oracle.

## Native chart and seam contract

Let the longitudinal coordinate be `u` in `[0, 2π)`. Möbius has `v` in `[-w, w]`; Klein has periodic `v` in `[-π, π)`. The longitudinal deck transformation is

\[
A(u,v)=(u+2\pi,-v),\qquad DA=\operatorname{diag}(1,-1).
\]

Klein also has `B(u,v)=(u,v+2π)` with identity derivative. Its generators satisfy `ABA⁻¹=B⁻¹`; they legitimately do not commute. Möbius transverse edges are physical reflecting boundaries, while Klein has no boundary. The quotient distinction follows the constructions in [Hatcher's topology notes](https://pi.math.cornell.edu/~hatcher/Top/TopNotes.pdf).

Canonicalization computes `k=floor(u/(2π))`, subtracts `2πk`, and multiplies `v`, the transverse coordinate velocity and the orientation-cover sign by `(-1)^k`. Klein then wraps `v` into `[-π,π)`. This handles arbitrary positive and negative crossings, including exact seam endpoints. The implementation must transform every tangent quantity with the same derivative, including force, candidate velocity, transported prior velocity and future directional memory. A coordinate seam is not a physical bounce.

Each agent carries an orientation-cover sign `σ∈{−1,+1}`. One twisted circuit changes its relation to the chart frame; two restore it. If `N` is the chart normal, `σN` follows the agent continuously. The sign does not select a different physical surface sheet. Native coordinates select the sheet; orientation state selects the agent's locally transported handedness.

## Möbius immersion and induced metric

Use the standard ruled immersion around world Y:

\[
X(u,v)=\big((R+v\cos(u/2))\cos u,\ v\sin(u/2),\ (R+v\cos(u/2))\sin u\big).
\]

This is the axis-adjusted surface used in [Oliver Knill's Harvard exhibit](https://legacy-www.math.harvard.edu/~knill/teaching/math22a2018/exhibits/moebius/index.html). Differentiating it gives

\[
g=\begin{pmatrix}H^2&0\\0&1\end{pmatrix},\qquad
H^2=(R+v\cos(u/2))^2+v^2/4.
\]

The proposed shape envelope is `w≥1`, `3≤R/w≤10`. Since `H≥R−w>0`, the immersion and metric are regular throughout that envelope. The area element is `H du dv`; initialization must weight native draws by `H`, rather than uniformly sampling the rectangular chart. The metric obeys the exact seam law `g(p)=DAᵀ g(Ap) DA`.

For physical orthonormal components `(a,b)` along the longitudinal and transverse axes, free motion satisfies

\[
\dot u=a/H,\quad \dot v=b,\quad
\dot a=-(H_v/H)ab,\quad \dot b=(H_v/H)a^2,
\]

where `H_v=((R+v cos(u/2)) cos(u/2)+v/4)/H`. Thus speed is conserved; this curvature is not an alignment force. Parallel transport along a chosen path rotates physical components by `ψ=∫H_v du`, followed by the transverse reflection when canonicalizing. A torus sine connection cannot be reused here.

The initial **research** query envelope is `q≤0.1w`; it has no certified geodesic approximation tolerance yet. Bounded edges must reflect the intrinsic outward velocity component and keep body centers inside the physical boundary margin. Validate `bodyRadius<w` before creating that margin. Near-edge density remains explicitly nominal unless a boundary correction is separately implemented.

## Figure-eight Klein immersion and induced metric

Choose the regular figure-eight immersion, rather than an unverified pinched bottle silhouette. Let `s` be section scale, and define

\[
C=\cos(u/2)\sin v-\sin(u/2)\sin(2v),\qquad
D=\sin(u/2)\sin v+\cos(u/2)\sin(2v).
\]

Then `X=((R+sC)cos u, sD, (R+sC)sin u)`. The native seam maps above preserve this immersion. Differentiation gives

\[
E=(R+sC)^2+\tfrac{s^2}{4}(\sin^2v+\sin^2(2v)),\quad
F=-s^2\sin^3v,\quad
G=s^2(\cos^2v+4\cos^2(2v)).
\]

The proposed shape envelope is `s≥1`, `3≤R/s≤10`. Here `|C|≤5/4` and `G≥31s²/64`. The azimuthal component of `X_u` is orthogonal to `X_v`, so

\[
\det g\ge (R-5s/4)^2\,31s^2/64>0.
\]

No singular-value clamp or hidden flat replacement is needed. A conservative global lower eigenvalue bound used by the prototype is

\[
\lambda_*=\frac{(R-5s/4)^2(31s^2/64)}{(R+5s/4)^2+345s^2/64}.
\]

These inequalities and derivative formulas are derived here from the chosen immersion; they are not accuracy claims from Geomstats. Klein initialization weights draws by `sqrt(EG−F²)`. Its tentative research query radius is `q≤0.1s`, pending the motion/log/transport audit below.

At `(u,0)` and `(u,π)`, the visible positions coincide exactly while the native points are distinct. Recovering `v` from the visible position cannot identify the agent's sheet. That is an architectural constraint, not a numerical issue to repair with an ambient-distance threshold.

## Motion, neighbor relation and orientation semantics

Use an orthonormal frame obtained from the analytic Jacobian:

\[
e_1=X_u/\sqrt E,\qquad e_2=(X_v-(F/E)X_u)/\sqrt{G-F^2/E}.
\]

Derive the Levi-Civita Christoffel symbols from `E,F,G` and their analytic derivatives. In this frame the path rotation one-form is `Ω_i=−sqrt((G−F²/E)/E) Γᵛ_{iu}`. The full Klein shear `F` participates in both motion and transport. The Möbius expression above is its diagonal special case.

Build a high-accuracy CPU RK4 geodesic/transport reference and local endpoint shooting before choosing a production approximation. A symmetric midpoint metric is only a candidate distance. A candidate log must back-transport its midpoint tangent over the **actual first half** of its chosen path. Use the same path and seam derivative for reverse transport; do not halve a whole-path connection integral without justification. An implicit midpoint component rotation can preserve physical speed, but its position and heading errors still require timestep refinement tests.

Temporal turning and acceleration require prior velocity transported along the actual motion and correction paths. Neighbor transport cannot substitute for that path. Boundary reflection and applied steering may produce real turning; a chart reflection must produce none.

The all-species metric registry remains, with honest domain semantics. Scalar speed, count, polarization magnitude, radial flow and unsigned turning survive orientation reversal. Intrinsic bearings use the agent's orientation frame `(e₁,σe₂)` and are labeled accordingly; raw chart-bearing differences are not globally meaningful. Orbit/spiral and vortex forces use agent-local chirality or an explicitly oriented local field patch. A globally continuous clockwise direction is unavailable. Render surfaces on both sides and transport body frames rather than assigning a global outward normal.

## Complete native broadphase and sheet-aware tools

Keep authoritative native `(u,v)` coordinates. A complete chart grid avoids the large false candidate sets of an ambient grid at Klein crossings. The private prototype uses three Möbius lifts and nine Klein lifts: `u+2πm`, `(-1)^m v+2πn`, with `m∈{−1,0,1}` and Klein `n∈{−1,0,1}`. Its small radius envelope makes this finite local set sufficient for the tested classifier; it is not a global cut-locus solver.

For Möbius midpoint classification, use coordinate reaches `(q/(R−w), q)`. For Klein use `q/sqrt(λ*)` on both angular coordinates. These bounds follow directly from positive-definite metric bounds, rather than visible separation. Enumerate every candidate in every reached cell, apply the intrinsic classifier and deduplicate by stable ID. No cell or neighbor capacity is permitted. Keep count/prefix/scatter and snapshot causality unchanged.

An embedded grid could also be conservative if its padding is proven against the selected local classifier. It must still filter by native relation; visually crossing sheets must not align, collide, share obstacles or contribute to density merely because their positions coincide. Native all-pairs tests remain the broadphase oracle.

Picking returns mesh/native UV coordinates, with refinement against the analytic immersion. Keep a list of valid ray hits and use nearest visible depth as the initial choice. At coincident hits, expose an explicit way to choose the other layer. Dragging keeps the previously selected native patch until the user changes it. A nearest-XYZ projection must not silently hop sheets.

Obstacle and force centers need native coordinates. Their visible center is derived from the selected native sheet. Intrinsic obstacle reach includes body and avoidance margins, as on the torus. A surface-disk scene variant or equivalent mandatory native-center field is needed before scene saving can represent these tools honestly. A world-space center alone is insufficient.

## Proposed analytic GPU and history layout

The [Particle layout](../src/lib/gpu/shaders/common.wgsl) is four rows totaling 64 bytes. Before the triangulated worlds, `position.w` at byte 12, `velocity.w` at byte 28 and `previousVelocity.w` at byte 44 were constant padding. The current triangle solver occupies them with `triangle + 1`, orientation sign and incomplete-walk status respectively. An alternative analytic backend could repurpose these lanes for native `u`, native `v` and orientation sign `σ`, but this requires an explicit packing and migration change; they are not spare storage. Keep ID, species index, alive flag and generation in the existing uint identity row. Such an alternative layout need not increase particle stride or storage-binding count.

In that proposed analytic layout, every particle writer, packer, unpacker, inspector and structural migration must preserve the native fields. World position remains a render cache derived from native coordinates; world velocity remains a physical tangent vector. Stable-ID survivor migration copies native identity and orientation before rebuilding grids. It must never infer a Klein sheet from the render cache.

Each current history sample occupies 32 bytes: world XYZ plus generation token in one block, with historical linear RGB and validity/face metadata in a second block. The triangle solver retains its face identity in that second block. For an analytic backend, the proposal is to encode native `(u,v,σ)` in the first three position lanes, retain the generation token in the fourth, preserve the RGB block and define its metadata explicitly, then reconstruct visible positions in the trail shader. Decode by world kind so existing worlds keep their representation. Interpolate through the selected native lift before canonicalization; preserve endpoints exactly and never interpolate orientation signs numerically through zero. Use the temporal phase rules already implemented. Orientation parity is applied as a transition, not used to break a physically continuous trail.

The existing history token uses numerical Float32 generation conversion. A future all-uint32 contract needs a bit-preserving token or an explicit exact-integer generation bound, including migration comparisons; changing the native payload does not create spare token storage. Force-pointer config and saved surface obstacles additionally need native center/patch orientation values. These changes can extend packed configuration without adding storage bindings.

## Gates before public exposure

The 13 private CPU tests pass for analytic Jacobians, induced metric identities, seam metric/vector equivalence, repeated signed crossings, orientation-cover continuity, Klein generator composition, the analytic regularity bound, distinct crossing sheets, and native-grid/all-pairs equality including more than 64 colocated neighbors.

Before adding either world to `WorldDefinition`, complete:

1. RK4/shooting motion and path transport oracles, with resolution convergence over the complete shape envelope, boundaries, both seams and Klein crossings. Require speed preservation and report measured distance, log-direction and transport errors. Use the torus gates of `<1%` distance and `<0.02 rad` directional/transport error as initial acceptance targets, tightening ranges if necessary.
2. CPU tests of symmetry/reverse transport, actual-path temporal turning, full-area initialization, complete grid queries, body/chiral force continuity, obstacle influence, native picking and phase-correct history. Verify one twisted loop reverses local chart handedness and two restore it.
3. Native Float32 CPU/GPU parity tests for metric, transition, motion, transport, all-pairs/grid, orientation bits, stable IDs and history. Stress signed-zero axes and corners. The existing raw-uint32 seed/tick contract stays intact.
4. Full-interface validation and a measured 5k/10k performance gate with trails, bloom and the same telemetry method. Record neighbor counts and native-grid cost separately from display FPS. Expand research radii only after rerunning the geometric and performance audits.

No Möbius/Klein scene defaults, live controls or claims of support are introduced by this prototype.

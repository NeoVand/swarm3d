# Curved and immersed surface worlds

Möbius strip, Klein bottle, projective plane and trefoil knot are surface domains. `radius` sets their scale, approximately the maximum distance from the origin, with `2 ≤ radius ≤ 10000`. Möbius, Klein and Trefoil now use continuous parametric geometry and induced local dynamics. Projective retains an explicit polyhedral metric: its Roman immersion has smooth pinch singularities.

Old Swarm's `embedding.ts` and `embed.wgsl` informed the ruled Möbius strip and Roman presentation. Klein restores the Dickson bottle, including the quarter-turn tube phase, reversing longitudinal seam and upright presentation. Trefoil is a circular tube around `(sin u + 2 sin 2u, cos u − 2 cos 2u, −sin 3u)`, with a periodic Frenet frame and upright framing. Projective connectivity comes from antipodal identification of an icosphere. Coincident vertices are never welded across unrelated immersion sheets. Mesh tests check connectedness, nondegeneracy, physical boundaries, Euler characteristics and reversing edge identifications.

Trefoil `radius` is Knot size; optional `tubeRadius` is physical cross-section radius. Its range is `0.04 × radius` through `0.16 × radius`, with an omitted value resolving to `0.15 × radius`. Size edits preserve the thickness ratio. Both controls start a fresh seeded run and preserve manual camera framing. Painted obstacles keep their native face/patch while the surface deforms.

## Continuous surface dynamics

The worker samples the visible parametric map and its first/mixed derivatives on a bounded lattice. Shared corner derivatives define a C1 bicubic Hermite field. Polynomial coefficients are precomputed once; the GPU evaluates the field and its derivatives with Horner arithmetic. Geometry, motion, induced metric and transport consume the same field. Display triangles supply picking, depth tessellation and saved tool patches; crossing their borders does not switch physical normals or force laws.

Authoritative native U/V coordinates identify an agent's surface point and immersion sheet. World XYZ is the derived render cache; velocity is a physical tangent vector. A topology-valid local chart lift resolves periodic and reflecting seams. Three-point quadrature measures the induced length of the lifted chart segment, with embedded chord length as a conservative floor. Displacement follows the observer's induced tangent direction. Tangent vectors are transported through sampled normals; midpoint UV stepping carries current and previous velocity over the same motion path. Physical Möbius edges reflect the moving velocity while retaining the transported prior velocity, so their real turns remain measurable.

This is a continuous **local approximation**, not an exact geodesic logarithm or an exact global parallel-transport solver. Relevant interaction and travel ranges remain below `0.15 × radius`. Independent circular arc, seam, orientation, rotation and temporal-motion tests accompany CPU/GPU parity. They do not certify arbitrary long-range shortest paths or a complete smooth-geodesic error envelope. Initialization and total area use the tessellated area approximation before projecting native samples onto the smooth field.

Möbius and Klein carry an independent orientation-cover sign. Crossing a reversing seam flips its relation to the chart frame; two circuits restore it. Native coordinates distinguish sheets; this sign controls local handedness. No globally continuous clockwise direction exists on these nonorientable surfaces.

## Neighborhoods and the corrected distance bug

The complete XYZ count/prefix/scatter index supplies candidates, with full radius reach and no crowded-cell capacity. Each candidate is filtered using the declared surface classifier. Smooth-domain distance is at least embedded chord distance, so the broadphase remains conservative. Native chart lifts keep nearby rendered strands or self-intersection sheets physically distinct. Cell occupancy can change dispatch order, but never interaction radius, accepted count or force law.

The previous solver incorrectly used a shortest path through triangle **centers** minus endpoint offsets as a lower bound on physical distance. That expression can exceed a valid surface path. It rejected genuinely nearby agents and changed abruptly when an observer entered a new face. It has been removed. Smooth Möbius/Klein/Trefoil no longer need a face-route table.

Projective still walks connected triangle edges, with barycentric stepping and transported current/prior velocities. Its local relation unfolds a centroid-selected route and takes the maximum of unfolded distance and embedded chord. The sparse route atlas defines this local polyhedral classifier; it is not an exact shortest-geodesic search. Known sub-radius physical walks verify that the invalid centroid floor no longer excludes their endpoints. Smooth projective dynamics and a round RP² metric remain research work.

## Tools, display and history

Picking chooses the nearest visible tagged triangle. Pointer fields and saved obstacles recover native coordinates within that patch, without searching an unrelated immersion sheet. Imported obstacles validate their face and position; ambiguous crossings should retain an explicit face. Painting a ring uses the domain's local motion operation. Disk reach includes body and avoidance margins.

Smooth bodies and trails use continuous presentation normals from the derivative lattice, avoiding face-sized shading patches. Projective presentation normals average connected local vertex fans, respecting orientation reversals and sheet identity; its physical normals remain polyhedral. The opaque depth skin follows surface tessellation.

Optional grids follow intrinsic coordinate families: knot rings/rails, bottle loops/rulings and Möbius width/length lines. Projective guides are source-sphere contours that descend through antipodal identification, with their frame rotated away from coincident Roman double curves. These are not Cartesian plane intersections through the displayed immersion. Guides retain depth testing and pixel-filtered ribbons.

World-space history retains historical linear RGB and integer face/patch identity within its existing 32-byte sample. Resampling preserves exact stored endpoints, interpolates native lifts on smooth worlds, and retains sheet identity. It never averages unrelated sheets or invents an intermediate generation token.

The 64-byte particle layout stays bounded. Smooth worlds use `position.w = U`, `previousVelocity.w = V`, and `velocity.w = ±1` orientation. Projective uses `position.w = triangle + 1` and `previousVelocity.w` as an incomplete-walk flag. Packing, unpacking, selected readbacks and identity migration decode by domain. Run generation and stable IDs remain in the uint identity row.

## Resources and verification

Geometry, field coefficients and presentation normals share the existing configuration binding. Each tick uploads only the dynamic prefix and obstacles; static geometry uploads at structural changes. Compute remains within eight storage bindings. Replacement buffers rebind draws/kernels and retire old allocations after submitted GPU work finishes. Unit geometry caches retain at most four shapes/thicknesses. Uniform scale edits transform packed coefficients; thickness edits rebuild a bounded field instead of a large shortest-path table.

At the measured 17.5-radius, 2.16-tube Trefoil configuration, packed geometry is about 0.78 MiB, versus the old 18.8 MiB route atlas. Klein is about 0.58 MiB and Möbius 0.19 MiB. Projective retains its sparse route atlas. These allocations are separate from population and trajectory memory. Dense physical neighborhoods can still cost quadratically when many agents genuinely interact; no neighbors are discarded to hide that cost.

`pnpm test:unit --run` covers C1 cell/seam continuity, induced circle distances, orientation, motion, reflection, topology, scenes, identity and historical colors. `node scripts/gpu-topology.mjs` exercises production motion/transport, all fifteen measurements, all twelve directed behaviors, tools, dense/coincident neighborhoods, independent immersed sheets, rigid rotations and replacement thicknesses. `node scripts/gpu-surface-grid.mjs` compares emitted contour endpoints against a CPU reference and checks subpixel radiance stability. Browser tests hold real slider gestures down while requiring distinct rendered intermediate worlds before release. Performance methodology and results are recorded in [PERFORMANCE.md](PERFORMANCE.md).

Old prerelease `genus2` scenes without obstacles normalize to `trefoil`. Former double-torus obstacles must be removed before conversion; former figure-eight Klein obstacles need repainting. Exact smooth geodesics, round projective metrics and arbitrary imported meshes remain separate research. [NONORIENTABLE.md](NONORIENTABLE.md) preserves the more ambitious analytic study.

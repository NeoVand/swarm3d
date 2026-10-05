# Triangulated surface worlds

Möbius strip, Klein bottle, projective plane and genus 2 torus are surface domains. Their scale is `radius`, meaning the maximum vertex distance from the origin, with `2 ≤ radius ≤ 10000`. This bounding radius is distinct from each axis's half-extent. They share a GPU surface solver, but retain their actual connectivity and boundaries. They are not volumes or flat quotient worlds.

The older Swarm's `embedding.ts` and `embed.wgsl` informed the ruled Möbius strip and Roman presentation. The Klein uses a regular figure-eight immersion; the genus 2 mesh joins two torus patches through a bridge. Projective connectivity comes from antipodal identification of an icosphere. Coincident embedded vertices are never welded across unrelated sheets. Mesh tests check connectedness, nondegenerate triangles, boundary count, Euler characteristics (0, 0, 1, −2), and reversing edge identifications.

## Physical model

Agents carry a triangle identifier, world position and tangent velocity. Motion walks barycentric coordinates to a triangle edge, unfolds into its connected neighbor, and transports the current and previous velocity through the same rotation. Reversing edge identifications flip an independent orientation sign. Physical Möbius edges reflect the moving velocity; the transported previous velocity retains the physical turn. Closed worlds have no physical boundary.

The authoritative metric is the visible piecewise-flat triangle surface. This is especially significant for the projective world: the Roman map has smooth pinch singularities, while its explicit triangles are nondegenerate. This does **not** claim a smooth Roman geodesic solver or the round metric of the antipodal sphere.

Local neighbor displacement and transport unfold a shortest centroid-graph path into the observer face. Its declared distance is the maximum of unfolded displacement length, embedded chord length, and centroid-path length minus the endpoint-to-centroid distances. The last floor prevents a remote route from inventing a shortcut at an immersion crossing. This is a local approximation, not an exact shortest geodesic. All active perception, rule, contact and complete obstacle-force ranges are strictly below `0.15 × radius`; a physical tick also travels less than that range. Integer costs normalized by surface scale make route selection deterministic under resizing.

The ordinary complete XYZ count/prefix/scatter grid supplies conservative candidates: the final distance is at least their embedded chord length. A sparse face-to-face atlas retains every route within `range + 2 × largest centroid-to-vertex face radius`. The declared path floor proves that no accepted pair falls outside this envelope. The atlas has no crowded-face or agent-count truncation. Native GPU comparisons use a small CPU all-pairs reference for this same declared classifier; agreement does not establish smooth-geodesic accuracy.

## Tools, rendering and history

Picking chooses the nearest ray-hit triangle. Pointer fields and saved obstacles retain that face, so tools do not leak across coincident sheets. Imported obstacles validate their declared face and point; older definitions without a face are normalized once from a valid mesh point. Ambiguous crossings should be saved with the explicit face. Painting a ring walks each endpoint across connected edges. Disk reach includes body and avoidance margins before the legal brush size is computed.

Bodies use the tagged face's tangent frame; the opaque depth skin uses the same triangles. Optional sparse coordinate contours and silhouette/physical boundary guides use pixel-filtered ribbons. World-space history retains face IDs alongside historical colors, without expanding the 32-byte sample. History resampling walks a local surface path and preserves integer face identity; distant/discontinuous samples retain the nearest recorded endpoint rather than making up a path.

The existing 64-byte particle uses `position.w = triangle + 1`, `velocity.w = ±1` orientation, and `previousVelocity.w` as an explicit incomplete-walk flag. Walks have a finite crossing bound and return finite on-face stopped motion if that bound is exhausted. GPU gates require zero such failures in their motion fixtures. Stable IDs, population migration and per-tick immutable measurement snapshots remain unchanged.

## Resources and checks

Mesh geometry and the relation atlas share the existing configuration storage binding. Initial/world-layout edits upload the atlas; each tick uploads only the 256-byte configuration prefix plus 32 bytes per obstacle. The compute path stays within eight storage bindings. Resizing buffers rebinds kernels/draws and retires old allocations after submitted GPU work finishes. Unit-shape atlas caching makes scale edits a linear buffer transformation rather than another shortest-path build.

At default resolution the four meshes contain 768, 2304, 640 and 3200 faces respectively. On the tested Apple M4, their static atlases occupy approximately 2.98, 10.15, 1.56 and 31.49 MiB. These are memory measurements, not frame-rate guarantees. Dense all-pairs physical neighborhoods can remain expensive despite complete indexing.

`pnpm test:unit --run` covers topology, orientation, complete crowded queries, rotational invariance, scale invariance, scenes, population identity and history. `node scripts/gpu-topology.mjs` checks production WGSL motion, transport, all fifteen measurements, all twelve directed behaviors, forces and obstacles, dense/coincident neighborhoods, independent immersed sheets and 120 free-motion ticks per world. `pnpm exec playwright test e2e/world-topology-ui.e2e.ts e2e/logo.e2e.ts` checks the eight-choice two-row selector, scale edits, scene export, rendered worlds, narrow layout, looping logo and reduced motion. Run GPU suites without another active simulation competing for the device.

Smooth geodesic accuracy/convergence, round projective metrics, alternative Klein displays, and arbitrary imported meshes remain separate research. See [NONORIENTABLE.md](NONORIENTABLE.md) for the analytic solver study.

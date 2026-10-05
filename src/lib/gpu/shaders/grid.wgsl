import { Particle } from "./common.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> indices: array<u32>;
@group(0) @binding(4) var<storage, read_write> blocks: array<u32>;
var<workgroup> scan: array<u32, 256>;
fn cell_index(p: vec3f) -> u32 {
  let dims = vec3u(config[3].xyz);
  let xyz = vec3u(clamp(floor((p - config[4].xyz) / config[4].w), vec3f(0.0), vec3f(dims - vec3u(1u))));
  return xyz.x + dims.x * (xyz.y + dims.y * xyz.z);
}
@compute @workgroup_size(256)
fn clear_grid(@builtin(global_invocation_id) id: vec3u) {
  let cells = u32(config[3].w);
  // The trailing word chooses an evaluation order, never caps cell membership.
  if (id.x==0u && arrayLength(&grid)>3u*cells) { atomicStore(&grid[3u*cells],0u); }
  if (id.x < cells) {
    atomicStore(&grid[id.x], 0u);
    atomicStore(&grid[cells + id.x], 0u);
    atomicStore(&grid[2u*cells + id.x], 0u);
  }
}
@compute @workgroup_size(256)
fn count_particles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(config[0].x)) { return; }
  let orderFlag=3u*u32(config[3].w);
  let hasMetadata=arrayLength(&grid)>orderFlag;
  if (particles[id.x].identity.z == 0u) {
    if (hasMetadata) { atomicOr(&grid[orderFlag],1u); }
    return;
  }
  let previousCount=atomicAdd(&grid[cell_index(particles[id.x].position.xyz)], 1u);
  // One flag operation per crowded cell, not per agent beyond the threshold.
  if (hasMetadata && previousCount==256u) { atomicOr(&grid[orderFlag],1u); }
}
@compute @workgroup_size(256)
fn prefix_cells(@builtin(local_invocation_id) local: vec3u, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * 256u + local.x;
  let cells = u32(config[3].w);
  var count = 0u;
  if (index < cells) { count = atomicLoad(&grid[index]); }
  scan[local.x] = count;
  workgroupBarrier();
  for (var stride = 1u; stride < 256u; stride *= 2u) {
    var addend = 0u;
    if (local.x >= stride) { addend = scan[local.x - stride]; }
    workgroupBarrier();
    scan[local.x] += addend;
    workgroupBarrier();
  }
  if (index < cells) { atomicStore(&grid[cells + index], scan[local.x] - count); }
  if (local.x == 255u) { blocks[group.x] = scan[255u]; }
}
@compute @workgroup_size(256)
fn prefix_blocks(@builtin(local_invocation_id) local: vec3u) {
  let count = (u32(config[3].w) + 255u) / 256u;
  var original = 0u;
  if (local.x < count) { original = blocks[local.x]; }
  scan[local.x] = original;
  workgroupBarrier();
  for (var stride = 1u; stride < 256u; stride *= 2u) {
    var addend = 0u;
    if (local.x >= stride) { addend = scan[local.x - stride]; }
    workgroupBarrier();
    scan[local.x] += addend;
    workgroupBarrier();
  }
  if (local.x < count) { blocks[local.x] = scan[local.x] - original; }
}
@compute @workgroup_size(256)
fn finish_prefix(@builtin(global_invocation_id) id: vec3u) {
  let cells = u32(config[3].w);
  if (id.x < cells) {
    atomicAdd(&grid[cells + id.x], blocks[id.x / 256u]);
    atomicStore(&grid[2u*cells + id.x], 0u);
  }
}
@compute @workgroup_size(256)
fn scatter_particles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(config[0].x) || particles[id.x].identity.z == 0u) { return; }
  let cell = cell_index(particles[id.x].position.xyz);
  let cells = u32(config[3].w);
  let slot = atomicAdd(&grid[2u*cells + cell], 1u);
  indices[atomicLoad(&grid[cells + cell]) + slot] = id.x;
}

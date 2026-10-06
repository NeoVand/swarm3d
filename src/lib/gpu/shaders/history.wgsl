import { smooth_kind, smooth_face_tag } from "./topology-smooth.wgsl";
import { Particle, Metrics } from "./common.wgsl";
import { agent_color } from "./visual.wgsl";
import { is_topology } from "./topology.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> history: array<vec4f>;
@group(0) @binding(3) var<storage, read> metrics: array<Metrics>;
@group(0) @binding(4) var<storage, read> species: array<vec4f>;
@compute @workgroup_size(128)
fn write_history(@builtin(global_invocation_id) invocation: vec3u) {
  let index=invocation.x;
  let samples=u32(config[10].x);
  if (index>=u32(config[0].x) || config[15].y<0.5 || samples==0u) { return; }
  let particle=particles[index];
  if (particle.identity.z==0u) { return; }
  let slot=index*samples+u32(config[10].y)%samples;
  history[slot]=vec4f(particle.position.xyz,f32(particle.identity.w));
  // Colors are linear RGB sampled from the same immutable measured snapshot as
  // body rendering. The SOA color prefix is capacity*samples, not population.
  var tag=select(1.0,particle.position.w,is_topology(config[0].z));if(smooth_kind(config[0].z)){tag=smooth_face_tag(&config,vec2f(particle.position.w,particle.previousVelocity.w));}
  history[u32(config[15].z)+slot]=vec4f(agent_color(particle.identity.y*64u,metrics[index],&species,u32(config[13].x)),tag);
}

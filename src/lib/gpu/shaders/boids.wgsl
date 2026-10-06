import { smooth_kind, smooth_topology, smooth_basis, smooth_display_normal } from "./topology-smooth.wgsl";
import { is_surface, body_center, Particle, Metrics, Camera, safe_unit, tangent, world_normal, world_basis, metric, normalized_metric, hsl_rgb } from "./common.wgsl";
import { agent_color, body_vertex } from "./visual.wgsl";
import { is_topology, topology_normal, topology_basis, topology_display_normal } from "./topology.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> metrics: array<Metrics>;
@group(0) @binding(3) var<storage, read> species: array<vec4f>;
@group(0) @binding(4) var<uniform> camera: Camera;
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) world: vec3f,
  @location(3) selected: f32,
}
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  var output: VertexOutput;
  if (instance>=u32(config[0].x) || particles[instance].identity.z==0u) { output.position=vec4f(2.0,2.0,2.0,1.0); return output; }
  let particle=particles[instance];
  let row=particle.identity.y*64u;
  let shape=u32(species[row+4u].w);
  var forward=safe_unit(particle.velocity.xyz);
  var up=vec3f(0.0,1.0,0.0);
  if (is_surface(config[0].z)) {
    up=world_normal(particle.position.xyz,config[0].z,config[5].z);
    if(smooth_kind(config[0].z)){up=smooth_display_normal(&config,vec2f(particle.position.w,particle.previousVelocity.w))*select(-1.0,1.0,particle.velocity.w>=0.0);}
    else if (is_topology(config[0].z)) { up=topology_display_normal(&config,particle.position,particle.velocity.w); }
    forward=safe_unit(tangent(forward,up));
    if (length(forward)<1e-7) {
      forward=world_basis(particle.position.xyz,config[0].z,config[5].z).x;
      if(smooth_kind(config[0].z)){forward=smooth_basis(smooth_topology(&config,vec2f(particle.position.w,particle.previousVelocity.w)),particle.velocity.w).x;}
      else if (is_topology(config[0].z)) { forward=topology_basis(&config,particle.position.w,particle.velocity.w).x; }
    }
  }
  if (length(forward)<1e-7) { forward=vec3f(0.0,0.0,1.0); }
  let surfaceNormal=up;
  var right=safe_unit(cross(up,forward));
  if (length(right)<1e-7) { right=safe_unit(cross(vec3f(1.0,0.0,0.0),forward)); }
  up=safe_unit(cross(forward,right));
  if (shape==4u) { right=safe_unit(tangent(camera.right.xyz,forward)); up=safe_unit(cross(forward,right)); }
  let local=body_vertex(vertexIndex,shape);
  let orientation=mat3x3f(right,up,forward);
  let size=species[row].w;
  var center=body_center(particle.position.xyz,config[0].z,config[5].z,camera.position.xyz,size);
  if (is_topology(config[0].z)) {
    var n=surfaceNormal;
    if(!smooth_kind(config[0].z)){n=topology_display_normal(&config,particle.position,particle.velocity.w);}
    let lift=select(-1.0,1.0,dot(n,camera.position.xyz-particle.position.xyz)>=0.0)*min(size*1.1,length(camera.position.xyz-particle.position.xyz)*0.35);
    center=particle.position.xyz+n*lift;
  }
  let world=center+orientation*local*size;
  let first=body_vertex(vertexIndex/3u*3u,shape);
  let second=body_vertex(vertexIndex/3u*3u+1u,shape);
  let third=body_vertex(vertexIndex/3u*3u+2u,shape);
  var normal=safe_unit(cross(second-first,third-first));
  if (shape==3u) { normal=safe_unit(local); }
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.normal=orientation*normal;
  output.world=world;
  output.color=agent_color(row,metrics[instance],&species,u32(config[13].x));
  let selectedId=bitcast<u32>(config[14].w);
  output.selected=select(0.0,1.0,selectedId>0u && particle.identity.x==selectedId);
  return output;
}
@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // Normalize AFTER interpolation, especially for rounded bead normals.
  let normal=safe_unit(input.normal)*select(-1.0,1.0,front);
  let light=vec3f(-0.436436,0.872872,0.218218);
  let fill=vec3f(0.801784,0.267261,-0.534522);
  let view=safe_unit(camera.position.xyz-input.world);
  let diffuse=0.20+1.05*max(0.0,dot(normal,light))+0.16*max(0.0,dot(normal,fill));
  let facing=max(0.0,dot(normal,view));
  let rim=pow(1.0-facing,3.0)*0.20;
  let highlight=pow(max(0.0,dot(normal,safe_unit(light+view))),48.0)*0.42;
  // Highlights retain most of the body hue instead of coating every shape white.
  let specular=mix(vec3f(0.20),input.color,0.80)*highlight;
  let selection=input.selected*(input.color*0.35+vec3f(0.18,0.11,0.035));
  let day=(u32(config[15].w)&2u)!=0u;
  if (day) {
    // An ink-lit material remains readable against a bright stage, without
    // changing mapped hue, stored history colors, or simulation measurements.
    return vec4f(input.color*(0.14+diffuse*0.32)+specular*0.12+selection*0.32,1.0);
  }
  return vec4f(input.color*(diffuse+rim)+specular+selection,1.0);
}

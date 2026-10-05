import { is_surface, view_lift, Particle, Metrics, Camera, PI, safe_unit, world_normal, surface_interpolate, surface_lift, torus_chart, torus_angles, metric, normalized_metric, hsl_rgb } from "./common.wgsl";
import { agent_color } from "./visual.wgsl";
import { is_topology, topology_normal } from "./topology.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> metrics: array<Metrics>;
@group(0) @binding(3) var<storage, read> species: array<vec4f>;
@group(0) @binding(4) var<storage, read> history: array<vec4f>;
@group(0) @binding(5) var<uniform> camera: Camera;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) color: vec4f, @location(1) transverse: f32 }
fn finite_record(value: vec4f) -> bool {
  return all((bitcast<vec4u>(value)&vec4u(0x7f800000u))!=vec4u(0x7f800000u));
}
fn recorded_color(slot: u32, fallback: vec3f) -> vec3f {
  let value=history[u32(config[15].z)+slot];
  if (value.w<0.5 || !finite_record(value)) { return fallback; }
  return max(value.xyz,vec3f(0.0));
}
fn trail_vertex(vertexIndex: u32, instance: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position=vec4f(2.0,2.0,2.0,1.0);
  output.color=vec4f(0.0);
  output.transverse=0.0;
  let samples=u32(config[10].x);
  if (instance>=u32(config[0].x) || samples<2u) { return output; }
  let particle=particles[instance];
  let row=particle.identity.y*64u;
  let age=vertexIndex/6u;
  let trail=species[row+3u];
  let seconds=species[row+5u].x;
  let sampleDt=config[10].z*config[1].x;
  let headElapsed=config[15].x;
  var segmentStart=0.0;
  if (age>0u) { segmentStart=headElapsed+f32(age-1u)*sampleDt; }
  if (particle.identity.z==0u || age>=min(samples-1u,u32(config[10].w)) || segmentStart>=seconds || trail.z<=0.0 || trail.w<=0.0) { return output; }
  let head=u32(config[10].y)%samples;
  var a=vec4f(particle.position.xyz,f32(particle.identity.w));
  if (age>0u) { a=history[instance*samples+(head+samples-age+1u)%samples]; }
  let aSlot=instance*samples+(head+samples-age+1u)%samples;
  let bSlot=instance*samples+(head+samples-age)%samples;
  let b=history[bSlot];
  if (!finite_record(a) || !finite_record(b)) { return output; }
  if (u32(a.w)!=particle.identity.w || u32(b.w)!=particle.identity.w) { return output; }
  let displacement=b.xyz-a.xyz;
  let distance=length(displacement);
  if ((bitcast<u32>(distance)&0x7f800000u)==0x7f800000u || distance<1e-7) { return output; }
  // History belongs to the motion that produced it. Current speed/body edits
  // cannot invalidate a retained segment; only world discontinuities can.
  let kind=config[0].z;
  if ((kind==0.0 || kind==2.0) && config[2].w>0.5) {
    if (abs(displacement.x)>config[2].x || abs(displacement.z)>config[2].z || (kind==0.0 && abs(displacement.y)>config[2].y)) { return output; }
  }
  if (kind==1.0 || kind==3.0) {
    if ((kind==1.0 && (length(a.xyz)<1e-7 || length(b.xyz)<1e-7)) || (kind==3.0 && (length(a.xz)<1e-7 || length(b.xz)<1e-7))) { return output; }
    if (dot(world_normal(a.xyz,kind,config[5].z),world_normal(b.xyz,kind,config[5].z))< -0.9999) { return output; }
  }
  if (kind==4.0) {
    let change=torus_angles(torus_chart(a.xyz,config[5].z),torus_chart(b.xyz,config[5].z));
    if (any(abs(change)>vec2f(PI*0.995))) { return output; }
  }
  let middle=(a.xyz+b.xyz)*0.5;
  var side=safe_unit(cross(displacement,camera.position.xyz-middle));
  if (length(side)<1e-7) { side=camera.right.xyz; }
  let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));
  let corner=corners[vertexIndex%6u];
  let segmentDuration=select(sampleDt,headElapsed,age==0u);
  let elapsed=segmentStart+corner.x*segmentDuration;
  let fade=clamp(1.0-elapsed/max(seconds,1e-7),0.0,1.0);
  var world=mix(a.xyz,b.xyz,corner.x)+side*corner.y*trail.w*0.5*sqrt(fade);
  // Intrinsic endpoints and a normal lift keep histories on their own surface.
  if (is_topology(kind)) {
    var aTag=particle.position.w;
    if (age>0u) { aTag=max(1.0,round(history[u32(config[15].z)+aSlot].w)); }
    let bTag=max(1.0,round(history[u32(config[15].z)+bSlot].w));
    let aNormal=topology_normal(&config,aTag,1.0);
    var bNormal=topology_normal(&config,bTag,1.0);
    if (dot(aNormal,bNormal)<0.0) { bNormal=-bNormal; }
    let normal=safe_unit(mix(aNormal,bNormal,corner.x));
    let lift=select(-1.0,1.0,dot(normal,camera.position.xyz-world)>=0.0)*species[row].w*0.18;
    world+=normal*lift;
  } else if (is_surface(kind)) {
    world=surface_interpolate(a.xyz,b.xyz,corner.x,kind,config[1].y,config[5].z)+side*corner.y*trail.w*0.5*sqrt(fade);
    world=surface_lift(world,kind,config[1].y,view_lift(world,kind,config[5].z,camera.position.xyz,select(species[row].w*0.12,max(species[row].w*0.12,config[1].y*0.0035),kind==4.0)),config[5].z);
  }
  let opacity=trail.z*fade*sqrt(fade);
  let currentColor=agent_color(row,metrics[instance],&species,u32(config[13].x));
  var aColor=currentColor;
  if (age>0u) { aColor=recorded_color(aSlot,currentColor); }
  let bColor=recorded_color(bSlot,currentColor);
  let rgb=mix(aColor,bColor,corner.x);
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.color=vec4f(rgb,opacity);
  output.transverse=corner.y;
  return output;
}
// Retain the six-vertex entry for reference comparisons and standalone fixtures.
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  return trail_vertex(vertexIndex,instance);
}
// A shared index buffer reuses the two duplicated corners of each quad. Keeping
// particle instances and triangle order unchanged preserves historical blending.
@vertex
fn vs_indexed(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let corners=array<u32,4>(0u,1u,2u,5u);
  return trail_vertex(vertexIndex/4u*6u+corners[vertexIndex%4u],instance);
}
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let edge=abs(input.transverse);
  let coverage=1.0-smoothstep(0.58,1.0,edge);
  let core=pow(max(1.0-edge*edge,0.0),4.0);
  let alpha=input.color.a*coverage;
  // A colored luminous center and soft shoulders, in the existing ribbon pass.
  let day=(u32(config[15].w)&2u)!=0u;
  let light=select(0.85+core*0.80,0.20+core*0.16,day);
  return vec4f(input.color.rgb*light*alpha,alpha);
}

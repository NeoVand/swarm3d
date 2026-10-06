import { is_surface, view_lift, volume_distance, Camera, Basis, TAU, safe_unit, basis, world_basis, surface_offset, surface_lift } from "./common.wgsl";
import { smooth_kind, smooth_point_chart, smooth_topology, smooth_basis, smooth_advance } from "./topology-smooth.wgsl";
import { is_topology, topology_walk, topology_basis, topology_normal } from "./topology.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<uniform> camera: Camera;
struct FieldStyle { color: vec4f, intent: vec4f }
@group(0) @binding(2) var<uniform> fieldStyle: FieldStyle;
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) chart: vec2f,
  @location(2) color: vec4f,
  @location(3) edge: f32,
}
fn hidden() -> VertexOutput {
  var output: VertexOutput;
  output.position=vec4f(2.0,2.0,2.0,1.0);
  return output;
}
fn world_per_pixel(point: vec3f) -> f32 {
  let clip=camera.viewProjection*vec4f(point,1.0);
  let scale=length(vec3f(camera.viewProjection[0].y,camera.viewProjection[1].y,camera.viewProjection[2].y));
  return 2.0*abs(clip.w)/(max(fieldStyle.intent.w,1.0)*max(scale,1e-7));
}
fn field_point(center: vec3f, frame: Basis, local: vec3f) -> vec3f {
  if (smooth_kind(config[0].z)) {
    let uv=smooth_point_chart(&config,vec4f(center,config[1].w));
    let motion=smooth_advance(&config,uv,1.0,frame.x*local.x+frame.y*local.y,vec3f(0.0),vec3f(0.0));
    let n=smooth_topology(&config,motion.uv).normal;
    let lift=select(-0.025,0.025,dot(n,camera.position.xyz-motion.position)>=0.0);
    return motion.position+n*lift;
  }
  if (is_topology(config[0].z)) {
    let motion=topology_walk(&config,vec4f(center,config[1].w),1.0,frame.x*local.x+frame.y*local.y,vec3f(0.0),vec3f(0.0));
    let n=topology_normal(&config,motion.position.w,1.0);
    let lift=select(-0.025,0.025,dot(n,camera.position.xyz-motion.position.xyz)>=0.0);
    return motion.position.xyz+n*lift;
  }
  if (is_surface(config[0].z)) {
    let point=surface_offset(center,frame.x*local.x+frame.y*local.y,config[0].z,config[1].y,config[5].z);
    let lift=view_lift(point,config[0].z,config[5].z,camera.position.xyz,select(0.04,max(0.04,config[1].y*0.004),config[0].z==4.0));
    return surface_lift(point,config[0].z,config[1].y,lift,config[5].z);
  }
  return center+frame.x*local.x+frame.y*local.y+frame.z*local.z;
}
// One tiny draw: true radius / ring peak, center cross, direction marks, and the
// volume field's exact finite depth band. No fullscreen pass or particle readback.
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (config[6].w<0.5) { return hidden(); }
  let periodicPlane=config[0].z==2.0 && config[2].w>0.5;
  let segments=select(64u,32u,periodicPlane);
  let contourLines=segments*2u;
  let perCopy=contourLines+2u+16u+8u;
  let line=index/6u;
  let copy=line/perCopy;
  let localLine=line%perCopy;
  if (copy>=select(1u,4u,periodicPlane)) { return hidden(); }
  var center=config[6].xyz;
  var frame=basis(config[11].yzw);
  if (is_surface(config[0].z)) { frame=world_basis(center,config[0].z,config[5].z); }
  if (smooth_kind(config[0].z)) { frame=smooth_basis(smooth_topology(&config,smooth_point_chart(&config,vec4f(center,config[1].w))),1.0); }
  else if (is_topology(config[0].z)) { frame=topology_basis(&config,config[1].w,1.0); }
  let radius=config[11].x;
  let pixel=world_per_pixel(center);
  let pressed=fieldStyle.intent.z>0.5;
  let enabled=fieldStyle.color.w>0.5;
  let strength=select(0.42,0.72,pressed)*select(0.5,1.0,enabled);
  var alpha=strength;
  var width=max(max(0.025,radius*0.0035),pixel*0.85)*select(1.0,1.3,pressed);
  var a=vec3f(0.0);
  var b=vec3f(0.0);
  if (localLine<contourLines) {
    let ring=localLine/segments;
    let segment=localLine%segments;
    let r=radius*select(1.0,select(0.13,0.7,config[7].z>0.5),ring==1u);
    let angle=f32(segment)*TAU/f32(segments);
    let next=f32(segment+1u)*TAU/f32(segments);
    a=vec3f(cos(angle)*r,sin(angle)*r,0.0);
    b=vec3f(cos(next)*r,sin(next)*r,0.0);
    // Boundary is clear; the ring's strongest band is brighter than the boundary.
    if (ring==0u) { alpha*=0.68; }
  } else if (localLine<contourLines+2u) {
    let centerSize=max(max(0.12,radius*0.065),pixel*5.0);
    if (localLine==contourLines) { a=vec3f(-centerSize,0.0,0.0); b=vec3f(centerSize,0.0,0.0); }
    else { a=vec3f(0.0,-centerSize,0.0); b=vec3f(0.0,centerSize,0.0); }
    alpha=min(0.95,strength*1.5);
  } else if (localLine<contourLines+18u) {
    if (!enabled || (abs(fieldStyle.intent.x)<1e-6 && abs(fieldStyle.intent.y)<1e-6)) { return hidden(); }
    let mark=localLine-contourLines-2u;
    let angle=f32(mark/2u)*TAU/8.0;
    let radial=vec2f(cos(angle),sin(angle));
    let radialWorld=frame.x*radial.x+frame.y*radial.y;
    let axis=select(safe_unit(config[8].xyz),frame.z,is_surface(config[0].z));
    let motion=-radialWorld*fieldStyle.intent.x+safe_unit(cross(axis,-radialWorld))*fieldStyle.intent.y;
    if (length(motion)<1e-7) { return hidden(); }
    let direction=safe_unit(vec3f(dot(motion,frame.x),dot(motion,frame.y),dot(motion,frame.z)));
    var sideways=safe_unit(cross(direction,vec3f(0.0,0.0,1.0)));
    if (length(sideways)<1e-7) { sideways=vec3f(1.0,0.0,0.0); }
    let centerMark=vec3f(radial*radius*select(0.55,0.7,config[7].z>0.5),0.0);
    let size=max(max(0.10,radius*0.035),pixel*2.5);
    let tip=centerMark+direction*size;
    a=tip;
    b=centerMark-direction*size+sideways*size*select(-0.65,0.65,(mark&1u)==1u);
    alpha*=select(0.65,0.95,pressed);
  } else {
    if (is_surface(config[0].z)) { return hidden(); }
    let rail=localLine-contourLines-18u;
    let angle=f32(rail%4u)*TAU/4.0;
    let radial=vec2f(cos(angle),sin(angle))*radius;
    let depth=config[7].w;
    if (rail<4u) { a=vec3f(radial,-depth); b=vec3f(radial,depth); }
    else {
      let side=select(-1.0,1.0,(rail&1u)==1u);
      a=vec3f(0.0,0.0,depth*side);
      b=vec3f(radial,depth*side);
    }
    alpha*=0.18;
    width*=0.65;
  }
  var worldA=field_point(center,frame,a);
  var worldB=field_point(center,frame,b);
  if (periodicPlane) {
    if ((copy&1u)!=0u) { let shift=2.0*config[2].x*select(1.0,-1.0,center.x>=0.0); worldA.x+=shift; worldB.x+=shift; center.x+=shift; }
    if ((copy&2u)!=0u) { let shift=2.0*config[2].z*select(1.0,-1.0,center.z>=0.0); worldA.z+=shift; worldB.z+=shift; center.z+=shift; }
  }
  let middle=(worldA+worldB)*0.5;
  var side=safe_unit(cross(worldB-worldA,camera.position.xyz-middle));
  if (length(side)<1e-7) { side=camera.right.xyz; }
  let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));
  let corner=corners[index%6u];
  let world=mix(worldA,worldB,corner.x)+side*width*corner.y;
  var output: VertexOutput;
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.world=world;
  output.chart=world.xz-center.xz;
  output.color=vec4f(fieldStyle.color.rgb*alpha,alpha);
  output.edge=corner.y;
  return output;
}
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  if (!is_surface(config[0].z) && volume_distance(input.world,config[0].z,config[1].y,config[2].xyz,config[5].z)>0.0) { discard; }
  if (config[0].z==2.0 && config[2].w>0.5 && any(abs(input.chart)>config[2].xz)) { discard; }
  if (config[0].z==2.0 && (abs(input.world.x)>config[2].x || abs(input.world.z)>config[2].z)) { discard; }
  if (config[0].z==3.0 && abs(input.world.y)>config[2].y) { discard; }
  return input.color*(1.0-smoothstep(0.72,1.0,abs(input.edge)));
}

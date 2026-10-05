import { Camera, Basis, PI, TAU, safe_unit, basis, world_normal, world_basis, surface_offset, surface_lift, torus_point, torus_frame } from "./common.wgsl";
import { sphere_point, sphere_vertex } from "./visual.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<uniform> camera: Camera;
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) color: vec4f,
  @location(3) chart: vec2f,
  @location(4) edge: f32,
}
fn hidden() -> VertexOutput {
  var output: VertexOutput;
  output.position=vec4f(2.0,2.0,2.0,1.0);
  output.normal=vec3f(0.0);
  output.world=vec3f(0.0);
  output.color=vec4f(0.0);
  output.chart=vec2f(0.0);
  output.edge=0.0;
  return output;
}
fn line_vertex(a: vec3f, b: vec3f, cornerIndex: u32, width: f32, color: vec4f) -> VertexOutput {
  let middle=(a+b)*0.5;
  var side=safe_unit(cross(b-a,camera.position.xyz-middle));
  if (length(side)<1e-7) { side=camera.right.xyz; }
  let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));
  let corner=corners[cornerIndex];
  let world=mix(a,b,corner.x)+side*width*corner.y;
  var output: VertexOutput;
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.normal=vec3f(0.0);
  output.world=world;
  output.color=color;
  output.chart=vec2f(0.0);
  output.edge=corner.y;
  return output;
}
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (config[12].z<0.5) { return hidden(); }
  let segment=index/6u;
  var a=vec3f(0.0);
  var b=vec3f(0.0);
  var width=0.010;
  var alpha=0.13;
  if (config[0].z<0.5) {
    if (segment>=12u) { return hidden(); }
    let axis=segment/4u;
    let side=segment%4u;
    let extent=config[2].xyz;
    a=-extent;
    b=-extent;
    for (var k=0u; k<3u; k++) {
      if (k==axis) { b[k]=extent[k]; }
      else {
        let bit=select(0u,1u,k>axis);
        a[k]=extent[k]*select(-1.0,1.0,((side>>bit)&1u)==1u);
        b[k]=a[k];
      }
    }
    width=0.018;
    alpha=0.26;
  } else if (config[0].z==1.0) {
    let radius=config[1].y*1.003;
    if (segment<384u) {
      let longitude=f32(segment/48u)/8.0;
      let latitude=f32(segment%48u)/48.0;
      a=sphere_point(longitude,latitude)*radius;
      b=sphere_point(longitude,latitude+1.0/48.0)*radius;
    } else if (segment<744u) {
      let cell=segment-384u;
      let latitude=f32(cell/72u+1u)/6.0;
      let longitude=f32(cell%72u)/72.0;
      a=sphere_point(longitude,latitude)*radius;
      b=sphere_point(longitude+1.0/72.0,latitude)*radius;
    } else { return hidden(); }
    width=max(0.006,config[1].y*0.00035);
  } else if (config[0].z==2.0) {
    if (segment>=22u) { return hidden(); }
    let half=config[2].xyz;
    let axis=segment/11u;
    let fraction=f32(segment%11u)/10.0;
    if (axis==0u) { a=vec3f(-half.x,0.012,mix(-half.z,half.z,fraction)); b=vec3f(half.x,0.012,a.z); }
    else { a=vec3f(mix(-half.x,half.x,fraction),0.012,-half.z); b=vec3f(a.x,0.012,half.z); }
    alpha=select(0.085,0.24,segment%11u==0u || segment%11u==10u);
    if (segment%11u==5u) { alpha=0.18; }
    width=max(0.006,min(half.x,half.z)*0.0004);
  } else if (config[0].z==4.0) {
    var chartA=vec2f(0.0); var chartB=vec2f(0.0);
    if (segment<384u) {
      chartA=vec2f(f32(segment%48u)*TAU/48.0,f32(segment/48u)*TAU/8.0);
      chartB=chartA+vec2f(TAU/48.0,0.0);
    } else if (segment<768u) {
      let cell=segment-384u;
      chartA=vec2f(f32(cell/96u)*TAU/4.0,f32(cell%96u)*TAU/96.0);
      chartB=chartA+vec2f(0.0,TAU/96.0);
    } else { return hidden(); }
    a=torus_point(chartA,config[1].y+max(0.012,config[1].y*0.004),config[5].z);
    b=torus_point(chartB,config[1].y+max(0.012,config[1].y*0.004),config[5].z);
    width=max(0.005,config[1].y*0.0005);
  } else {
    let radius=config[1].y*1.002;
    let halfHeight=config[2].y;
    if (segment<8u) {
      let angle=f32(segment)*TAU/8.0;
      a=vec3f(radius*cos(angle),-halfHeight,radius*sin(angle));
      b=vec3f(a.x,halfHeight,a.z);
    } else if (segment<488u) {
      let cell=segment-8u;
      let height=mix(-halfHeight,halfHeight,f32(cell/96u)/4.0);
      let angle=f32(cell%96u)*TAU/96.0;
      let nextAngle=f32(cell%96u+1u)*TAU/96.0;
      a=vec3f(radius*cos(angle),height,radius*sin(angle));
      b=vec3f(radius*cos(nextAngle),height,radius*sin(nextAngle));
      alpha=select(0.11,0.26,cell/96u==0u || cell/96u==4u);
    } else { return hidden(); }
    width=max(0.006,config[1].y*0.00035);
  }
  return line_vertex(a,b,index%6u,width,vec4f(0.40,0.53,0.62,alpha));
}
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let antialias=max(fwidth(input.edge),0.08);
  let coverage=1.0-smoothstep(1.0-antialias,1.0,abs(input.edge));
  return vec4f(input.color.rgb,input.color.a*coverage);
}
// Opaque depth-writing meshes: sphere/cylinder10800, plane6, torus55296 vertices.
@vertex
fn vs_shell(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (config[0].z<0.5) { return hidden(); }
  var normal=vec3f(0.0,1.0,0.0);
  var world=vec3f(0.0);
  if (config[0].z==1.0) {
    normal=sphere_vertex(index,60u,30u);
    world=normal*config[1].y;
  } else if (config[0].z==2.0) {
    if (index>=6u) { return hidden(); }
    let corners=array<vec2f,6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
    let corner=corners[index];
    world=vec3f(corner.x*config[2].x,0.0,corner.y*config[2].z);
  } else if (config[0].z==4.0) {
    if (index>=55296u) { return hidden(); }
    let cell=index/6u;
    let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
    let corner=corners[index%6u];
    let chart=vec2f((f32(cell/144u)+corner.y)*TAU/64.0,(f32(cell%144u)+corner.x)*TAU/144.0);
    normal=torus_frame(chart).z;
    world=torus_point(chart,config[1].y,config[5].z);
  } else {
    let cell=index/6u;
    let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
    let corner=corners[index%6u];
    let angle=(f32(cell%60u)+corner.x)*TAU/60.0;
    let height=mix(-config[2].y,config[2].y,(f32(cell/60u)+corner.y)/30.0);
    normal=vec3f(cos(angle),0.0,sin(angle));
    world=normal*config[1].y+vec3f(0.0,height,0.0);
  }
  var output: VertexOutput;
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.normal=normal;
  output.world=world;
  output.color=vec4f(0.018,0.026,0.039,1.0);
  output.chart=vec2f(0.0);
  output.edge=0.0;
  return output;
}
@fragment
fn fs_shell(input: VertexOutput) -> @location(0) vec4f {
  // The runtime sets writeMask:[]: this shell only hides far-side agents in
  // depth, leaving the actual background and the optional wire guides untouched.
  return vec4f(0.0);

}
// Draw 10800 vertices per obstacle instance; boxes and caps collapse unused triangles.
@vertex
fn vs_obstacles(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  if (instance>=u32(config[9].y) || config[9].w<0.5) { return hidden(); }
  let obstacle=config[16u+2u*instance];
  let size=config[17u+2u*instance].xyz;
  var world=vec3f(0.0);
  var normal=vec3f(0.0);
  var chart=vec2f(0.0);
  if (config[0].z>0.5) {
    let periodicPlane=config[0].z==2.0 && config[2].w>0.5;
    let copies=select(1u,4u,periodicPlane);
    if (index>=2592u*copies) { return hidden(); }
    let copy=index/2592u;
    let localIndex=index%2592u;
    let frame=world_basis(obstacle.xyz,config[0].z,config[5].z);
    let capRadius=select(size.x,length(size),obstacle.w>0.5);
    let cell=localIndex/6u;
    let angular=cell%36u;
    let radial=cell/36u;
    let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
    let corner=corners[localIndex%6u];
    let angle=(f32(angular)+corner.x)*TAU/36.0;
    let radius=(f32(radial)+corner.y)*capRadius/12.0;
    world=surface_offset(obstacle.xyz,(frame.x*cos(angle)+frame.y*sin(angle))*radius,config[0].z,config[1].y,config[5].z);
    normal=world_normal(world,config[0].z,config[5].z);
    world=surface_lift(world,config[0].z,config[1].y,select(0.015,max(0.015,config[1].y*0.004),config[0].z==4.0),config[5].z);
    chart=world.xz-obstacle.xz;
    if ((copy&1u)!=0u) { world.x+=2.0*config[2].x*select(1.0,-1.0,obstacle.x>=0.0); }
    if ((copy&2u)!=0u) { world.z+=2.0*config[2].z*select(1.0,-1.0,obstacle.z>=0.0); }
  } else if (obstacle.w<0.5) {
    normal=sphere_vertex(index,60u,30u);
    world=obstacle.xyz+normal*size.x;
  } else {
    if (index>=36u) { return hidden(); }
    let face=index/6u;
    let axis=face/2u;
    let sign=select(-1.0,1.0,(face%2u)==1u);
    let corners=array<vec2f,6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
    let corner=corners[index%6u];
    var local=vec3f(0.0);
    local[axis]=sign;
    local[(axis+1u)%3u]=corner.x;
    local[(axis+2u)%3u]=corner.y;
    normal[axis]=sign;
    world=obstacle.xyz+local*size;
  }
  var output: VertexOutput;
  output.position=camera.viewProjection*vec4f(world,1.0);
  output.normal=normal;
  output.world=world;
  output.color=vec4f(0.10,0.065,0.08,1.0);
  output.chart=chart;
  output.edge=0.0;
  return output;
}
@fragment
fn fs_obstacles(input: VertexOutput) -> @location(0) vec4f {
  if (config[0].z==2.0 && config[2].w>0.5 && any(abs(input.chart)>config[2].xz)) { discard; }
  if (config[0].z==2.0 && (abs(input.world.x)>config[2].x || abs(input.world.z)>config[2].z)) { discard; }
  if (config[0].z==3.0 && abs(input.world.y)>config[2].y) { discard; }
  let diffuse=0.6+0.4*max(0.0,dot(safe_unit(input.normal),safe_unit(vec3f(-0.4,0.8,0.6))));
  let view=safe_unit(camera.position.xyz-input.world);
  let rim=pow(1.0-max(0.0,dot(safe_unit(input.normal),view)),3.0)*0.09;
  return vec4f(input.color.rgb*diffuse+vec3f(rim,rim*0.55,rim*0.4),1.0);
}
// Two real radius contours: outer radius and ring peak (or disk half radius).
// 1536 vertices, premultiplied alpha, depth tested, no depth writes.
@vertex
fn vs_force(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (config[6].w<0.5 || config[7].x<0.5) { return hidden(); }
  let periodicPlane=config[0].z==2.0 && config[2].w>0.5;
  let segments=select(128u,32u,periodicPlane);
  let copy=index/(segments*12u);
  let localIndex=index%(segments*12u);
  let ring=localIndex/(segments*6u);
  let segment=(localIndex%(segments*6u))/6u;
  let radius=config[11].x*select(1.0,select(0.5,0.7,config[7].z>0.5),ring==1u);
  let angle=f32(segment)*TAU/f32(segments);
  let nextAngle=f32(segment+1u)*TAU/f32(segments);
  var frame=basis(config[11].yzw);
  var center=config[6].xyz;
  var a=vec3f(0.0);
  var b=vec3f(0.0);
  if (config[0].z>0.5) {
    frame=world_basis(center,config[0].z,config[5].z);
    a=surface_offset(center,(frame.x*cos(angle)+frame.y*sin(angle))*radius,config[0].z,config[1].y,config[5].z);
    b=surface_offset(center,(frame.x*cos(nextAngle)+frame.y*sin(nextAngle))*radius,config[0].z,config[1].y,config[5].z);
    a=surface_lift(a,config[0].z,config[1].y,select(0.04,max(0.04,config[1].y*0.004),config[0].z==4.0),config[5].z);
    b=surface_lift(b,config[0].z,config[1].y,select(0.04,max(0.04,config[1].y*0.004),config[0].z==4.0),config[5].z);
    if ((copy&1u)!=0u) { let shift=2.0*config[2].x*select(1.0,-1.0,center.x>=0.0); a.x+=shift; b.x+=shift; center.x+=shift; }
    if ((copy&2u)!=0u) { let shift=2.0*config[2].z*select(1.0,-1.0,center.z>=0.0); a.z+=shift; b.z+=shift; center.z+=shift; }
  } else {
    center+=frame.z*(config[12].x-dot(center,frame.z));
    a=center+(frame.x*cos(angle)+frame.y*sin(angle))*radius;
    b=center+(frame.x*cos(nextAngle)+frame.y*sin(nextAngle))*radius;
  }
  let alpha=select(0.5,0.22,ring==1u);
  var output=line_vertex(a,b,index%6u,max(0.025,radius*0.004),vec4f(vec3f(0.62,0.83,0.86)*alpha,alpha));
  output.chart=output.world.xz-center.xz;
  return output;
}
@fragment
fn fs_force(input: VertexOutput) -> @location(0) vec4f {
  if (config[0].z==2.0 && config[2].w>0.5 && any(abs(input.chart)>config[2].xz)) { discard; }
  if (config[0].z==2.0 && (abs(input.world.x)>config[2].x || abs(input.world.z)>config[2].z)) { discard; }
  if (config[0].z==3.0 && abs(input.world.y)>config[2].y) { discard; }
  let coverage=1.0-smoothstep(0.72,1.0,abs(input.edge));
  return input.color*coverage;
}
// 11 quiet lines on each plane axis, 6 vertices per line = 132 vertices.
// The actual user-selected plane is intersected with the simulation box.
@vertex
fn vs_plane(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (config[0].z>0.5 || config[12].w<0.5 || config[12].w>2.5) { return hidden(); }
  let segment=index/6u;
  if (segment>=22u) { return hidden(); }
  let frame=basis(config[11].yzw);
  let extent=config[2].xyz;
  let radius=length(extent);
  let spacing=max(radius/5.0,0.25);
  let offset=f32(i32(segment%11u)-5)*spacing;
  var direction=frame.y;
  var origin=frame.z*config[12].x+frame.x*offset;
  if (segment>=11u) { direction=frame.x; origin=frame.z*config[12].x+frame.y*offset; }
  var lower=-radius*2.0;
  var upper=radius*2.0;
  for (var axis=0u; axis<3u; axis++) {
    if (abs(direction[axis])<1e-7) {
      if (abs(origin[axis])>extent[axis]) { return hidden(); }
    } else {
      let a=(-extent[axis]-origin[axis])/direction[axis];
      let b=(extent[axis]-origin[axis])/direction[axis];
      lower=max(lower,min(a,b));
      upper=min(upper,max(a,b));
    }
  }
  if (lower>=upper) { return hidden(); }
  let alpha=select(0.055,0.17,segment%11u==5u);
  return line_vertex(origin+direction*lower,origin+direction*upper,index%6u,max(0.012,spacing*0.003),vec4f(vec3f(0.30,0.62,0.65)*alpha,alpha));
}
@fragment
fn fs_plane(input: VertexOutput) -> @location(0) vec4f {
  let coverage=1.0-smoothstep(0.72,1.0,abs(input.edge));
  let center=safe_unit(config[11].yzw)*config[12].x;
  let fade=1.0-smoothstep(length(config[2].xyz)*0.45,length(config[2].xyz),length(input.world-center));
  return input.color*coverage*fade;
}

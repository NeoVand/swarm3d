import { is_surface, view_lift, volume_distance, Camera, Basis, PI, TAU, safe_unit, basis, world_normal, world_basis, surface_offset, surface_lift, torus_point, torus_frame } from "./common.wgsl";
import { sphere_point, sphere_vertex } from "./visual.wgsl";
import { is_topology, topology_header, topology_face_row, topology_basis, topology_walk, topology_normal } from "./topology.wgsl";
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
// Guides use clip-space ribbons with a full pixel-filter fringe. A world-space
// quad clips away that fringe when a line becomes subpixel and causes motion shimmer.
struct GuideOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) @interpolate(linear) distance: f32,
  @location(2) @interpolate(flat) halfWidth: f32,
}
fn hidden_guide() -> GuideOutput {
  return GuideOutput(vec4f(2.0,2.0,2.0,1.0),vec4f(0.0),0.0,0.0);
}
fn guide_vertex(a: vec3f, b: vec3f, cornerIndex: u32, halfWidth: f32, color: vec4f) -> GuideOutput {
  var clipA=camera.viewProjection*vec4f(a,1.0);
  var clipB=camera.viewProjection*vec4f(b,1.0);
  // Clip before perspective division: a segment crossing the near plane must
  // not flip its extrusion or produce a full-screen quad behind the camera.
  if (clipA.z<0.0 && clipB.z<0.0) { return hidden_guide(); }
  if (clipA.z<0.0) { clipA=mix(clipA,clipB,-clipA.z/(clipB.z-clipA.z)); }
  if (clipB.z<0.0) { clipB=mix(clipB,clipA,-clipB.z/(clipA.z-clipB.z)); }
  if (clipA.w<=1e-5 || clipB.w<=1e-5) { return hidden_guide(); }
  let projectionY=length(vec3f(camera.viewProjection[0].y,camera.viewProjection[1].y,camera.viewProjection[2].y));
  let projectionX=length(vec3f(camera.viewProjection[0].x,camera.viewProjection[1].x,camera.viewProjection[2].x));
  let height=select(800.0,camera.up.w,camera.up.w>0.0);
  let aspect=select(projectionY/max(projectionX,1e-7),camera.right.w,camera.right.w>0.0);
  let viewport=vec2f(height*aspect,height);
  let screenA=clipA.xy/clipA.w*viewport*0.5;
  let screenB=clipB.xy/clipB.w*viewport*0.5;
  let direction=screenB-screenA;
  if (length(direction)<1e-4) { return hidden_guide(); }
  let side=vec2f(-direction.y,direction.x)/length(direction);
  let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));
  let corner=corners[cornerIndex];
  let radius=halfWidth+1.0;
  var clip=mix(clipA,clipB,corner.x);
  clip.x+=side.x*radius*corner.y*2.0/viewport.x*clip.w;
  clip.y+=side.y*radius*corner.y*2.0/viewport.y*clip.w;
  return GuideOutput(clip,color,radius*corner.y,halfWidth);
}
// Offset toward the eye continuously. Normal-side switching at a silhouette
// created discontinuous vertices during orbit; this also works from inside a skin.
fn guide_point(point: vec3f, kind: f32) -> vec3f {
  if (!is_surface(kind)) { return point; }
  let view=camera.position.xyz-point;
  let lift=min(max(0.018,config[1].y*0.004),length(view)*0.25);
  return point+safe_unit(view)*lift;
}
fn sphere_circle(angle: f32, axis: u32, radius: f32) -> vec3f {
  if (axis==0u) { return vec3f(0.0,cos(angle),sin(angle))*radius; }
  if (axis==1u) { return vec3f(cos(angle),0.0,sin(angle))*radius; }
  return vec3f(cos(angle),sin(angle),0.0)*radius;
}
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> GuideOutput {
  let kind=config[0].z;
  if (is_topology(kind)) {
    let header=topology_header(&config);
    let face=index/54u;
    if (face>=u32(config[header].x)) { return hidden_guide(); }
    let row=header+1u+face*8u;
    let local=index%54u;
    let day=(u32(config[15].w)&2u)!=0u;
    let color=select(vec3f(0.48,0.65,0.72),vec3f(0.22,0.37,0.47),day);
    if (local>=18u) {
      if ((u32(config[15].w)&1u)==0u) { return hidden_guide(); }
      // Sparse reference contours across the actual surface. Displaying every
      // triangle edge made the grid read as a dense engineering wireframe.
      let axis=(local-18u)/12u;
      let ordinal=((local-18u)%12u)/6u;
      let points=array<vec3f,3>(config[row].xyz,config[row+1u].xyz,config[row+2u].xyz);
      let low=min(points[0][axis],min(points[1][axis],points[2][axis]));
      let high=max(points[0][axis],max(points[1][axis],points[2][axis]));
      let spacing=config[1].y*0.25;
      let level=(ceil(low/spacing)+f32(ordinal))*spacing;
      if (high-low<spacing*1e-5 || level>high) { return hidden_guide(); }
      var a=vec3f(0.0); var b=vec3f(0.0); var found=0u;
      for (var edge=0u;edge<3u;edge++) {
        let start=points[edge]; let end=points[(edge+1u)%3u];
        let change=end[axis]-start[axis];
        if (abs(change)<spacing*1e-6) { continue; }
        let fraction=(level-start[axis])/change;
        if (fraction<0.0 || fraction>1.0) { continue; }
        let point=mix(start,end,fraction);
        if (found==0u) { a=point; found=1u; }
        else if (length(point-a)>spacing*1e-6) { b=point; found=2u; break; }
      }
      if (found<2u) { return hidden_guide(); }
      return guide_vertex(guide_point(a,kind),guide_point(b,kind),index%6u,0.4,vec4f(color,0.09));
    }
    if (config[12].z<=0.5) { return hidden_guide(); }
    let edge=local/6u;
    let neighbor=config[row+edge].w;
    var outline=neighbor<0.0;
    let a=config[row+(edge+1u)%3u].xyz;
    let b=config[row+(edge+2u)%3u].xyz;
    let normal=config[row+3u].xyz;
    if (neighbor>=0.0) {
      if (u32(neighbor)<face) { return hidden_guide(); }
      let other=header+1u+u32(neighbor)*8u;
      let view=camera.position.xyz-(a+b)*0.5;
      outline=dot(normal,view)*dot(config[other+3u].xyz,view)*config[row+4u][edge]<0.0;
    }
    if (!outline) { return hidden_guide(); }
    return guide_vertex(guide_point(a,kind),guide_point(b,kind),index%6u,0.65,vec4f(color,0.25));
  }
  let shape=select(select(kind,kind-3.0,kind>=6.0),1.0,kind==5.0);
  let boundary=config[12].z>0.5;
  let grid=(u32(config[15].w)&1u)!=0u;
  if (!boundary && !grid) { return hidden_guide(); }
  let segment=index/6u;
  var a=vec3f(0.0); var b=vec3f(0.0); var alpha=0.25;
  var isGrid=false;
  let radius=config[1].y; let extent=config[2].xyz;
  if (shape==0.0) {
    if (segment<12u) {
      if (!boundary) { return hidden_guide(); }
      let axis=segment/4u; let side=segment%4u;
      a=-extent; b=-extent;
      for (var k=0u; k<3u; k++) {
        if (k==axis) { b[k]=extent[k]; }
        else { let bit=select(k,k-1u,k>axis); a[k]=extent[k]*select(-1.0,1.0,((side>>bit)&1u)==1u); b[k]=a[k]; }
      }
    } else {
      if (!grid || segment>=45u) { return hidden_guide(); }
      isGrid=true; let line=segment-12u; let axis=line/11u; let fraction=f32(line%11u)/10.0;
      // Three intersecting reference planes communicate depth without a cage.
      if (axis==0u) { a=vec3f(-extent.x,0.0,mix(-extent.z,extent.z,fraction)); b=vec3f(extent.x,0.0,a.z); }
      else if (axis==1u) { a=vec3f(mix(-extent.x,extent.x,fraction),0.0,-extent.z); b=vec3f(a.x,0.0,extent.z); }
      else { a=vec3f(0.0,-extent.y,mix(-extent.z,extent.z,fraction)); b=vec3f(0.0,extent.y,a.z); }
    }
  } else if (shape==1.0) {
    if (segment<288u) {
      if (!boundary) { return hidden_guide(); }
      let angle=f32(segment%96u)*TAU/96.0; let axis=segment/96u;
      a=sphere_circle(angle,axis,radius); b=sphere_circle(angle+TAU/96.0,axis,radius);
    } else {
      if (!grid || segment>=1032u) { return hidden_guide(); }
      isGrid=true; let cell=segment-288u;
      if (cell<384u) {
        let longitude=f32(cell/48u)/8.0; let latitude=f32(cell%48u)/48.0;
        a=sphere_point(longitude,latitude)*radius; b=sphere_point(longitude,latitude+1.0/48.0)*radius;
      } else {
        let ring=cell-384u; let latitude=f32(ring/72u+1u)/6.0; let longitude=f32(ring%72u)/72.0;
        a=sphere_point(longitude,latitude)*radius; b=sphere_point(longitude+1.0/72.0,latitude)*radius;
      }
    }
  } else if (shape==2.0) {
    if (segment<4u) {
      if (!boundary) { return hidden_guide(); }
      let corners=array<vec3f,4>(vec3f(-extent.x,0.0,-extent.z),vec3f(extent.x,0.0,-extent.z),vec3f(extent.x,0.0,extent.z),vec3f(-extent.x,0.0,extent.z));
      a=corners[segment]; b=corners[(segment+1u)%4u];
    } else {
      if (!grid || segment>=26u) { return hidden_guide(); }
      isGrid=true; let line=segment-4u; let axis=line/11u; let fraction=f32(line%11u)/10.0;
      if (axis==0u) { a=vec3f(-extent.x,0.0,mix(-extent.z,extent.z,fraction)); b=vec3f(extent.x,0.0,a.z); }
      else { a=vec3f(mix(-extent.x,extent.x,fraction),0.0,-extent.z); b=vec3f(a.x,0.0,extent.z); }
    }
  } else if (shape==3.0) {
    if (segment<196u) {
      if (!boundary) { return hidden_guide(); }
      if (segment<192u) {
        let height=extent.y*select(-1.0,1.0,segment>=96u); let angle=f32(segment%96u)*TAU/96.0;
        a=vec3f(radius*cos(angle),height,radius*sin(angle)); b=vec3f(radius*cos(angle+TAU/96.0),height,radius*sin(angle+TAU/96.0));
      } else {
        let angle=f32(segment-192u)*TAU/4.0; a=vec3f(radius*cos(angle),-extent.y,radius*sin(angle)); b=vec3f(a.x,extent.y,a.z);
      }
    } else {
      if (!grid || segment>=492u) { return hidden_guide(); }
      isGrid=true; let line=segment-196u;
      if (line<8u) { let angle=f32(line)*TAU/8.0; a=vec3f(radius*cos(angle),-extent.y,radius*sin(angle)); b=vec3f(a.x,extent.y,a.z); }
      else { let ring=line-8u; let height=mix(-extent.y,extent.y,f32(ring/96u+1u)/4.0); let angle=f32(ring%96u)*TAU/96.0; a=vec3f(radius*cos(angle),height,radius*sin(angle)); b=vec3f(radius*cos(angle+TAU/96.0),height,radius*sin(angle+TAU/96.0)); }
    }
  } else if (shape==4.0) {
    var chartA=vec2f(0.0); var chartB=vec2f(0.0);
    if (segment<384u) {
      if (!boundary) { return hidden_guide(); }
      let ring=segment/96u; let angle=f32(segment%96u)*TAU/96.0;
      if (ring<2u) { chartA=vec2f(f32(ring)*PI,angle); chartB=chartA+vec2f(0.0,TAU/96.0); }
      else { chartA=vec2f(angle,f32(ring-2u)*PI); chartB=chartA+vec2f(TAU/96.0,0.0); }
    } else {
      if (!grid || segment>=1152u) { return hidden_guide(); }
      isGrid=true; let line=segment-384u;
      if (line<384u) { chartA=vec2f(f32(line%96u)*TAU/96.0,f32(line/96u)*TAU/4.0); chartB=chartA+vec2f(TAU/96.0,0.0); }
      else { let ring=line-384u; chartA=vec2f(f32(ring/48u)*TAU/8.0,f32(ring%48u)*TAU/48.0); chartB=chartA+vec2f(0.0,TAU/48.0); }
    }
    a=torus_point(chartA,radius,config[5].z); b=torus_point(chartB,radius,config[5].z);
  } else { return hidden_guide(); }
  a=guide_point(a,kind); b=guide_point(b,kind);
  alpha=select(alpha,0.075,isGrid);
  let day=(u32(config[15].w)&2u)!=0u;
  let color=select(vec3f(0.48,0.65,0.72),vec3f(0.22,0.37,0.47),day);
  return guide_vertex(a,b,index%6u,select(0.65,0.4,isGrid),vec4f(color,alpha));
}
@fragment
fn fs_main(input: GuideOutput) -> @location(0) vec4f {
  // Pixel-box integration preserves line energy at every subpixel phase,
  // including widths below one pixel. Derivatives account for diagonal lines.
  let footprint=max(fwidth(input.distance),1.0);
  let coverage=clamp((input.halfWidth+footprint*0.5-abs(input.distance))/footprint,0.0,min(1.0,2.0*input.halfWidth/footprint));
  return vec4f(input.color.rgb,input.color.a*coverage);
}
// Opaque depth-writing meshes: sphere/cylinder10800, plane6, torus55296 vertices.
@vertex
fn vs_shell(@builtin(vertex_index) index: u32) -> VertexOutput {
  if (!is_surface(config[0].z)) { return hidden(); }
  var normal=vec3f(0.0,1.0,0.0);
  var world=vec3f(0.0);
  if (is_topology(config[0].z)) {
    let header=topology_header(&config);
    let face=index/3u;
    if (face>=u32(config[header].x)) { return hidden(); }
    let row=header+1u+face*8u;
    world=config[row+index%3u].xyz;
    normal=config[row+3u].xyz;
  } else if (config[0].z==1.0) {
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
  if (is_surface(config[0].z)) {
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
    world=surface_lift(world,config[0].z,config[1].y,view_lift(world,config[0].z,config[5].z,camera.position.xyz,select(0.015,max(0.015,config[1].y*0.004),config[0].z==4.0)),config[5].z);
    if (is_topology(config[0].z)) {
      let localFrame=topology_basis(&config,config[17u+instance*2u].w,1.0);
      let motion=topology_walk(&config,vec4f(obstacle.xyz,config[17u+instance*2u].w),1.0,(localFrame.x*cos(angle)+localFrame.y*sin(angle))*radius,vec3f(0.0),vec3f(0.0));
      normal=topology_normal(&config,motion.position.w,1.0);
      world=motion.position.xyz+normal*select(-0.015,0.015,dot(normal,camera.position.xyz-motion.position.xyz)>=0.0);
    }
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
  if (is_surface(config[0].z)) {
    frame=world_basis(center,config[0].z,config[5].z);
    a=surface_offset(center,(frame.x*cos(angle)+frame.y*sin(angle))*radius,config[0].z,config[1].y,config[5].z);
    b=surface_offset(center,(frame.x*cos(nextAngle)+frame.y*sin(nextAngle))*radius,config[0].z,config[1].y,config[5].z);
    a=surface_lift(a,config[0].z,config[1].y,view_lift(a,config[0].z,config[5].z,camera.position.xyz,select(0.04,max(0.04,config[1].y*0.004),config[0].z==4.0)),config[5].z);
    b=surface_lift(b,config[0].z,config[1].y,view_lift(b,config[0].z,config[5].z,camera.position.xyz,select(0.04,max(0.04,config[1].y*0.004),config[0].z==4.0)),config[5].z);
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
  if (is_surface(config[0].z) || config[12].w<0.5 || config[12].w>2.5) { return hidden(); }
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
  if (volume_distance(input.world,config[0].z,config[1].y,config[2].xyz,config[5].z)>0.0) { discard; }
  let coverage=1.0-smoothstep(0.72,1.0,abs(input.edge));
  let center=safe_unit(config[11].yzw)*config[12].x;
  let fade=1.0-smoothstep(length(config[2].xyz)*0.45,length(config[2].xyz),length(input.world-center));
  return input.color*coverage*fade;
}

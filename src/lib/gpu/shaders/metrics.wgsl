import { Particle, Metrics, Basis, PI, TAU, safe_unit, tangent, world_normal, world_basis, periodic_axis, bearing, delta_world, torus_relation, broadphase_radius, neighbor_velocity, largest_eigenvalue, circular_mix, cell_span, span_cell, cell_intersects_query } from "./common.wgsl";
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> previousMetrics: array<Metrics>;
@group(0) @binding(3) var<storage, read_write> nextMetrics: array<Metrics>;
@group(0) @binding(4) var<storage, read> grid: array<u32>;
@group(0) @binding(5) var<storage, read> indices: array<u32>;
@group(0) @binding(6) var<storage, read> species: array<vec4f>;
@compute @workgroup_size(128)
fn measure(@builtin(global_invocation_id) invocation: vec3u) {
  let index=invocation.x;
  if (index>=u32(config[0].x)) { return; }
  let particle=particles[index];
  if (particle.identity.z==0u) { nextMetrics[index]=Metrics(vec4f(0.0),vec4f(0.0),vec4f(0.0),vec4f(0.0)); return; }
  let p=particle.position.xyz;
  let velocity=particle.velocity.xyz;
  let previous=particle.previousVelocity.xyz;
  let surface=config[0].z>0.5;
  let periodic=config[2].w>0.5;
  let radius=species[particle.identity.y*64u].z;
  var queryChord=radius;
  if (config[0].z==1.0) { queryChord=2.0*config[1].y*sin(radius/max(2.0*config[1].y,1e-7)); }
  let dims=vec3u(config[3].xyz);
  let broadQuery=broadphase_radius(radius,config[0].z,config[1].y,config[5].z);
  let xs=cell_span(p.x,broadQuery,config[4].x,config[2].x,config[4].w,dims.x,periodic);
  let ys=cell_span(p.y,broadQuery,config[4].y,config[2].y,config[4].w,dims.y,periodic_axis(config[0].z,1u,config[2].w));
  let zs=cell_span(p.z,broadQuery,config[4].z,config[2].z,config[4].w,dims.z,periodic);
  var count=0.0;
  var meanDelta=vec3f(0.0);
  var meanVelocity=vec3f(0.0);
  var meanUnitVelocity=vec3f(0.0);
  var radialFlow=0.0;
  var moment=mat3x3f(vec3f(0.0),vec3f(0.0),vec3f(0.0));
  for (var iz=0u; iz<zs.count+zs.extraCount; iz++) {
    let z=span_cell(zs,iz);
    for (var iy=0u; iy<ys.count+ys.extraCount; iy++) {
      let y=span_cell(ys,iy);
      for (var ix=0u; ix<xs.count+xs.extraCount; ix++) {
        let x=span_cell(xs,ix);
        let cell=x+dims.x*(y+dims.y*z);
        let offset=grid[u32(config[3].w)+cell];
        for (var j=0u; j<grid[cell]; j++) {
          let neighborIndex=indices[offset+j];
          if (neighborIndex==index) { continue; }
          let neighbor=particles[neighborIndex];
          let chord=neighbor.position.xyz-p;
          if (config[0].z==1.0 && dot(chord,chord)>queryChord*queryChord*1.00001) { continue; }
          var displacement=vec3f(0.0);
          var distance=0.0;
          if (config[0].z==4.0) {
            let relation=torus_relation(p,neighbor.position.xyz,config[1].y,config[5].z);
            displacement=relation.displacement;
            distance=relation.distance;
          } else {
            displacement=delta_world(p,neighbor.position.xyz,config[0].z,config[2].w,config[1].y,config[2].xyz,config[5].z);
            distance=length(displacement);
          }
          if (distance>radius) { continue; }
          let otherVelocity=neighbor_velocity(neighbor.velocity.xyz,neighbor.position.xyz,p,config[0].z,config[5].z);
          count+=1.0;
          meanDelta+=displacement;
          meanVelocity+=otherVelocity;
          meanUnitVelocity+=safe_unit(otherVelocity);
          radialFlow+=dot(safe_unit(otherVelocity-velocity),safe_unit(displacement));
          moment+=mat3x3f(displacement*displacement.x,displacement*displacement.y,displacement*displacement.z);
        }
      }
    }
  }
  let speed=length(velocity);
  var turnRate=0.0;
  if (speed>1e-7 && length(previous)>1e-7) {
    let a=safe_unit(velocity);
    let b=safe_unit(previous);
    turnRate=atan2(length(cross(a,b)),dot(a,b))/max(config[1].x,1e-7);
  }
  let acceleration=length(velocity-previous)/max(config[1].x,1e-7);
  var anisotropy=0.0;
  var polarization=0.0;
  if (count>0.0) {
    meanDelta/=count;
    meanVelocity/=count;
    meanUnitVelocity/=count;
    radialFlow/=count;
    moment*=1.0/count;
    let trace=moment[0].x+moment[1].y+moment[2].z;
    if (trace>1e-8) {
      let dimension=select(3.0,2.0,surface);
      anisotropy=clamp((dimension*largest_eigenvalue(moment)/trace-1.0)/(dimension-1.0),0.0,1.0);
    }
    polarization=clamp(length(meanUnitVelocity),0.0,1.0);
  }
  var neighborhood=4.0*PI*radius*radius*radius/3.0;
  var frame=Basis(vec3f(1.0,0.0,0.0),vec3f(0.0,0.0,-1.0),vec3f(0.0,1.0,0.0));
  if (surface) {
    neighborhood=PI*radius*radius;
    if (config[0].z==1.0) { neighborhood=2.0*PI*config[1].y*config[1].y*(1.0-cos(radius/config[1].y)); }
    frame=world_basis(p,config[0].z,config[5].z);
  }
  let heading=bearing(velocity,Basis(vec3f(1.0,0.0,0.0),vec3f(0.0,0.0,-1.0),vec3f(0.0,1.0,0.0)));
  var axis=safe_unit(config[8].xyz);
  if (surface) { axis=world_normal(p,config[0].z,config[5].z); }
  let projectedVelocity=tangent(velocity,axis);
  let projectedOutward=tangent(-meanDelta,axis);
  var centerOrbitAngle=0.0;
  var centerRadialSpeed=0.0;
  var speedContrast=0.0;
  if (count>0.0) {
    centerRadialSpeed=dot(velocity,safe_unit(meanDelta));
    speedContrast=abs(speed-length(meanVelocity))/max(species[particle.identity.y*64u].x,1e-7);
    if (length(projectedVelocity)>1e-7 && length(projectedOutward)>1e-7) {
      centerOrbitAngle=fract(atan2(dot(cross(projectedVelocity,projectedOutward),axis),dot(projectedVelocity,projectedOutward))/TAU+0.5);
    }
  }
  let measured=Metrics(vec4f(speed,turnRate,acceleration,count),vec4f(count/max(neighborhood,1e-7),anisotropy,polarization,radialFlow),vec4f(heading,length(meanDelta),bearing(meanDelta,frame),bearing(meanVelocity,frame)),vec4f(centerOrbitAngle,centerRadialSpeed,speedContrast,0.0));
  let old=previousMetrics[index];
  let alpha=select(clamp(config[9].x,0.0,1.0),1.0,old.a.x<0.0);
  var result=Metrics(mix(old.a,measured.a,alpha),mix(old.b,measured.b,alpha),mix(old.c,measured.c,alpha),mix(old.d,measured.d,alpha));
  result.a.x=measured.a.x;
  result.a.w=measured.a.w;
  result.b.x=measured.b.x;
  result.c.x=circular_mix(old.c.x,measured.c.x,alpha);
  result.c.z=circular_mix(old.c.z,measured.c.z,alpha);
  result.c.w=circular_mix(old.c.w,measured.c.w,alpha);
  result.d.x=circular_mix(old.d.x,measured.d.x,alpha);
  nextMetrics[index]=result;
}

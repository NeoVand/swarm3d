import { Basis, safe_unit, tangent } from "./common.wgsl";

// Piecewise-flat topology backend. XYZ alone cannot identify an immersion's
// sheet: every query/motion retains the face tag stored in Particle.position.w.
// Static face/CSR data lives after the dynamic obstacle rows in config, keeping
// the portable eight-storage-buffer compute layout.
export fn is_topology(kind: f32) -> bool { return kind>=8.0 && kind<=11.0; }
export fn topology_header(config: ptr<storage,array<vec4f>,read>) -> u32 {
  return 16u+2u*u32((*config)[9].y);
}
export fn topology_face_row(config: ptr<storage,array<vec4f>,read>, tag: f32) -> u32 {
  let header=topology_header(config);
  return header+1u+u32(max(tag-1.0,0.0))*8u;
}
fn valid_face(config: ptr<storage,array<vec4f>,read>, tag: f32) -> bool {
  let header=topology_header(config);
  return header<arrayLength(config) && tag>=1.0 && tag<=(*config)[header].x;
}
export fn topology_normal(config: ptr<storage,array<vec4f>,read>, tag: f32, orientation: f32) -> vec3f {
  let row=topology_face_row(config,tag);
  return safe_unit((*config)[row+3u].xyz)*select(-1.0,1.0,orientation>=0.0);
}
export fn topology_basis(config: ptr<storage,array<vec4f>,read>, tag: f32, orientation: f32) -> Basis {
  let row=topology_face_row(config,tag);
  let n=topology_normal(config,tag,orientation);
  let x=safe_unit((*config)[row+1u].xyz-(*config)[row].xyz);
  return Basis(x,safe_unit(cross(n,x)),n);
}
export struct TopologyRelation {
  displacement: vec3f,
  distance: f32,
  velocity: vec3f,
  valid: bool,
}
export fn topology_relation(config: ptr<storage,array<vec4f>,read>, observer: vec4f, neighborPoint: vec4f, velocity: vec3f) -> TopologyRelation {
  var result=TopologyRelation(vec3f(0.0),0.0,vec3f(0.0),false);
  if (!valid_face(config,observer.w) || !valid_face(config,neighborPoint.w)) { return result; }
  let header=topology_header(config);
  let face=topology_face_row(config,observer.w);
  let span=(*config)[face+6u];
  let start=u32(span.x);
  let count=u32(span.y);
  let base=u32((*config)[header].z);
  let targetFace=u32(neighborPoint.w-1.0);
  // A static sparse local atlas rejects unrelated sheets before arithmetic.
  // Rows are sorted by target face; no per-cell or per-agent neighbor cap.
  var lo=0u;
  var hi=count;
  while (lo<hi) {
    let middle=(lo+hi)/2u;
    let candidate=u32((*config)[base+(start+middle)*5u].x);
    if (candidate<targetFace) { lo=middle+1u; } else { hi=middle; }
  }
  if (lo>=count) { return result; }
  let row=base+(start+lo)*5u;
  if (u32((*config)[row].x)!=targetFace) { return result; }
  let rotation=mat3x3f((*config)[row+1u].xyz,(*config)[row+2u].xyz,(*config)[row+3u].xyz);
  let n=topology_normal(config,observer.w,1.0);
  let displacement=tangent(rotation*neighborPoint.xyz+(*config)[row+4u].xyz-observer.xyz,n);
  let localDistance=length(displacement);
  let chord=length(neighborPoint.xyz-observer.xyz);
  // Centroid graph route cost is not a lower bound on physical distance.
  let distance=max(localDistance,chord);
  result.displacement=displacement;
  result.distance=distance;
  result.velocity=tangent(rotation*velocity,n);
  result.valid=true;
  return result;
}
fn barycentric(config: ptr<storage,array<vec4f>,read>, tag: f32, point: vec3f) -> vec3f {
  let row=topology_face_row(config,tag);
  let a=(*config)[row].xyz;
  let e=(*config)[row+1u].xyz-a;
  let f=(*config)[row+2u].xyz-a;
  let d=point-a;
  let ee=dot(e,e); let ef=dot(e,f); let ff=dot(f,f);
  let denominator=max(ee*ff-ef*ef,1e-20);
  let u=(ff*dot(d,e)-ef*dot(d,f))/denominator;
  let v=(ee*dot(d,f)-ef*dot(d,e))/denominator;
  return vec3f(1.0-u-v,u,v);
}
fn from_barycentric(config: ptr<storage,array<vec4f>,read>, tag: f32, bary: vec3f) -> vec3f {
  let row=topology_face_row(config,tag);
  return (*config)[row].xyz*bary.x+(*config)[row+1u].xyz*bary.y+(*config)[row+2u].xyz*bary.z;
}
fn rotate_edge(vector: vec3f, axis: vec3f, cosine: f32, sine: f32) -> vec3f {
  return vector*cosine+cross(axis,vector)*sine+axis*dot(axis,vector)*(1.0-cosine);
}
export struct TopologyMotion {
  position: vec4f,
  velocity: vec4f,
  previousVelocity: vec3f,
  complete: bool,
}
export fn topology_walk(config: ptr<storage,array<vec4f>,read>, initial: vec4f, initialOrientation: f32, displacement: vec3f, velocity: vec3f, previous: vec3f) -> TopologyMotion {
  if (!valid_face(config,initial.w)) { return TopologyMotion(initial,vec4f(0.0,0.0,0.0,1.0),vec3f(0.0),false); }
  var tag=initial.w;
  var orientation=select(-1.0,1.0,initialOrientation>=0.0);
  var position=initial.xyz;
  var moving=tangent(displacement,topology_normal(config,tag,orientation));
  var current=tangent(velocity,topology_normal(config,tag,orientation));
  var old=tangent(previous,topology_normal(config,tag,orientation));
  var complete=false;
  // A finite guard catches malformed topology/vertex fans. It does not drop
  // agents or neighbors: callers preserve a telemetry failure flag and gates
  // require complete=true. Normal physical steps cross only a few faces.
  for (var crossing=0u; crossing<128u; crossing++) {
    if (length(moving)<1e-9) { complete=true; break; }
    let origin=barycentric(config,tag,position);
    let destination=barycentric(config,tag,position+moving);
    if (all(destination>=vec3f(-1e-6))) {
      let inside=max(destination,vec3f(0.0));
      position=from_barycentric(config,tag,inside/max(inside.x+inside.y+inside.z,1e-20));
      moving=vec3f(0.0);
      complete=true;
      break;
    }
    var fraction=1.0;
    var edge=0u;
    for (var candidate=0u; candidate<3u; candidate++) {
      if (destination[candidate]>= -1e-6) { continue; }
      let t=clamp(origin[candidate]/max(origin[candidate]-destination[candidate],1e-20),0.0,1.0);
      if (t<fraction) { fraction=t; edge=candidate; }
    }
    let row=topology_face_row(config,tag);
    let first=(edge+1u)%3u;
    let second=(edge+2u)%3u;
    let a=(*config)[row+first].xyz;
    let b=(*config)[row+second].xyz;
    let axis=safe_unit(b-a);
    position+=moving*fraction;
    // Snap only onto the crossed topological edge; never search nearby XYZ
    // triangles, which would switch sheets at a self intersection.
    let edgeFraction=clamp(dot(position-a,b-a)/max(dot(b-a,b-a),1e-20),0.0,1.0);
    position=mix(a,b,edgeFraction);
    moving*=1.0-fraction;
    let neighbor=(*config)[row+edge].w;
    if (neighbor<0.0) {
      let n=topology_normal(config,tag,orientation);
      let inward=safe_unit(cross(n,axis));
      moving-=inward*(2.0*dot(moving,inward));
      current-=inward*(2.0*dot(current,inward));
      continue;
    }
    let nextTag=neighbor+1.0;
    let parity=(*config)[row+4u][edge];
    let nextOrientation=orientation*parity;
    let n0=topology_normal(config,tag,orientation);
    let n1=topology_normal(config,nextTag,nextOrientation);
    let cs=vec2f(clamp(dot(n0,n1),-1.0,1.0),dot(axis,cross(n0,n1)));
    let unit=cs/max(length(cs),1e-20);
    moving=rotate_edge(moving,axis,unit.x,unit.y);
    current=rotate_edge(current,axis,unit.x,unit.y);
    old=rotate_edge(old,axis,unit.x,unit.y);
    tag=nextTag;
    orientation=nextOrientation;
  }
  // Incomplete walks are explicit, finite, on-face recoveries. A bad fan cannot
  // fling a boid through another immersion sheet or consume an unbounded loop.
  if (!complete) { current=vec3f(0.0); }
  return TopologyMotion(vec4f(position,tag),vec4f(current,orientation),old,complete);
}

// Display normals are the oriented manifold vertex fan average. Dynamics on
// Projective remain genuinely piecewise-flat and continue using topology_normal.
export fn topology_display_normal(config:ptr<storage,array<vec4f>,read>,point:vec4f,orientation:f32)->vec3f {
 let header=topology_header(config);let field=u32((*config)[header].w);
 if(field==0u || (*config)[field].z!=3.0){return topology_normal(config,point.w,orientation);}
 let bary=barycentric(config,point.w,point.xyz);let row=field+1u+3u*u32(max(0.0,point.w-1.0));
 return safe_unit((*config)[row].xyz*bary.x+(*config)[row+1u].xyz*bary.y+(*config)[row+2u].xyz*bary.z)*select(-1.0,1.0,orientation>=0.0);
}

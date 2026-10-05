export struct Particle {
  position: vec4f,
  velocity: vec4f,
  previousVelocity: vec4f,
  identity: vec4u,
}
export struct Metrics { a: vec4f, b: vec4f, c: vec4f, d: vec4f }
export struct Camera {
  viewProjection: mat4x4f,
  position: vec4f,
  right: vec4f,
  up: vec4f,
}
export struct Basis { x: vec3f, y: vec3f, z: vec3f }
export const PI: f32 = 3.141592653589793;
export const TAU: f32 = 6.283185307179586;
export fn safe_unit(v: vec3f) -> vec3f { return v / max(length(v), 1e-7); }
export fn limited(v: vec3f, maximum: f32) -> vec3f {
  return v * min(1.0, max(0.0, maximum) / max(length(v), 1e-7));
}
export fn tangent(v: vec3f, n: vec3f) -> vec3f { return v - n * dot(v, n); }
export fn basis(normal: vec3f) -> Basis {
  let n = safe_unit(normal);
  let reference = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), length(cross(vec3f(0.0,1.0,0.0),n)) < 1e-6);
  let x = safe_unit(cross(reference, n));
  return Basis(x, cross(n, x), n);
}
export fn bearing(v: vec3f, frame: Basis) -> f32 {
  let x=dot(v,frame.x);
  let y=dot(v,frame.y);
  if (length(vec2f(x,y)) < 1e-7) { return 0.0; }
  // Define exact axis bearings explicitly; some native backends lose the sign
  // of atan2's numerator when its denominator is a signed zero.
  if (x==0.0) { return select(0.75,0.25,y>0.0); }
  if (y==0.0) { return select(0.5,0.0,x>0.0); }
  return fract(atan2(y,x) / TAU + 1.0);
}
export fn hash_u32(value: u32) -> u32 {
  var x = value;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}
export fn random_unit(key: u32) -> vec3f {
  let a = f32(hash_u32(key) & 0xffffffu) / 16777216.0;
  let b = f32(hash_u32(key ^ 0xa511e9b3u) & 0xffffffu) / 16777216.0;
  let z = 2.0 * a - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(TAU * b), z, r * sin(TAU * b));
}
export fn sphere_delta(p: vec3f, q: vec3f, radius: f32) -> vec3f {
  let n = safe_unit(p);
  let m = safe_unit(q);
  let cosine = clamp(dot(n, m), -1.0, 1.0);
  let d = m - n * cosine;
  let theta = atan2(length(d),cosine);
  if (length(d) > 1e-7) { return safe_unit(d) * radius * theta; }
  if (cosine > 0.0) { return vec3f(0.0); }
  return basis(n).x * radius * PI;
}
export fn transport(v: vec3f, origin: vec3f, destination: vec3f) -> vec3f {
  let n = safe_unit(origin);
  let m = safe_unit(destination);
  let denom = 1.0 + dot(n, m);
  if (denom > 1e-5) { return tangent(v - (n + m) * (dot(v, m) / denom), m); }
  // Antipodes have no unique shortest geodesic; choose the same deterministic meridian as log.
  let axis = basis(n).y;
  return tangent(2.0 * axis * dot(axis, v) - v, m);
}
// Codes: volume box=0, sphere=1, flat XZ plane=2, Y-axis cylinder=3, ring torus=4.
export fn world_normal(p: vec3f, kind: f32, major: f32) -> vec3f {
  if (kind==1.0) { return safe_unit(p); }
  if (kind==4.0) {
    let radial=safe_unit(vec3f(p.x,0.0,p.z));
    return safe_unit(p-radial*major);
  }
  if (kind==3.0) {
    let radial=vec3f(p.x,0.0,p.z);
    if (length(radial)<1e-7) { return vec3f(1.0,0.0,0.0); }
    return safe_unit(radial);
  }
  return vec3f(0.0,1.0,0.0);
}
export fn world_basis(p: vec3f, kind: f32, major: f32) -> Basis {
  if (kind==2.0 || kind==0.0) {
    return Basis(vec3f(1.0,0.0,0.0),vec3f(0.0,0.0,-1.0),vec3f(0.0,1.0,0.0));
  }
  if (kind==4.0) { let frame=torus_frame(torus_chart(p,major)); return Basis(-frame.y,frame.x,frame.z); }
  return basis(world_normal(p,kind,major));
}
export fn oriented_angle(y: f32, x: f32) -> f32 {
  if (x==0.0) { if (y==0.0) { return 0.0; } return select(-PI*0.5,PI*0.5,y>0.0); }
  // The negative X axis has one canonical representative (+π), including −0 Y.
  if (y==0.0) { return select(PI,0.0,x>0.0); }
  return atan2(y,x);
}
// Strict comparisons retain the sign of exact half-period ties.
export fn minimum_image(value: f32, half: f32) -> f32 {
  if (value>half) { return value-ceil((value-half)/(2.0*half))*2.0*half; }
  if (value< -half) { return value+ceil((-half-value)/(2.0*half))*2.0*half; }
  return value;
}
export fn periodic_axis(kind: f32, axis: u32, periodic: f32) -> bool {
  return periodic>0.5 && (kind==0.0 || (kind==2.0 && axis!=1u));
}
export fn wrap_coordinate(value: f32, half: f32) -> f32 {
  return value-2.0*half*floor((value+half)/(2.0*half));
}
export fn reflect_coordinate(value: f32, velocity: f32, half: f32) -> vec2f {
  if (abs(value)<half) { return vec2f(value,velocity); }
  let unit=(value+half)/(2.0*half);
  let segment=floor(unit);
  let mirrored=i32(segment)%2!=0;
  let position=select(-half+fract(unit)*2.0*half,half-fract(unit)*2.0*half,mirrored);
  var reflected=select(velocity,-velocity,mirrored);
  if (position==half) { reflected=-abs(velocity); }
  if (position== -half) { reflected=abs(velocity); }
  return vec2f(position,reflected);
}
export fn cylinder_tangent(p: vec3f) -> vec3f {
  let n=world_normal(p,3.0,0.0);
  return vec3f(-n.z,0.0,n.x);
}
export struct Motion { position: vec3f, velocity: vec3f, previousVelocity: vec3f }
export struct TorusRelation { displacement: vec3f, distance: f32, angle: f32 }
export fn torus_chart(p: vec3f, major: f32) -> vec2f {
  return vec2f(oriented_angle(p.y,length(p.xz)-major),oriented_angle(p.z,p.x));
}
export fn torus_frame(chart: vec2f) -> Basis {
  let theta=chart.x; let phi=chart.y;
  let ct=cos(theta); let st=sin(theta); let cp=cos(phi); let sp=sin(phi);
  return Basis(vec3f(-st*cp,ct,-st*sp),vec3f(-sp,0.0,cp),vec3f(ct*cp,st,ct*sp));
}
export fn torus_point(chart: vec2f, radius: f32, major: f32) -> vec3f {
  let h=major+radius*cos(chart.x);
  return vec3f(h*cos(chart.y),radius*sin(chart.x),h*sin(chart.y));
}
export fn torus_sinc(angle: f32) -> f32 {
  if (abs(angle)<1e-3) { let square=angle*angle; return 1.0-square/6.0+square*square/120.0; }
  return sin(angle)/angle;
}
export fn torus_rotate(v: vec2f, angle: f32) -> vec2f {
  let c=cos(angle); let s=sin(angle);
  return vec2f(c*v.x-s*v.y,s*v.x+c*v.y);
}
export fn torus_components(v: vec3f, frame: Basis) -> vec2f { return vec2f(dot(v,frame.x),dot(v,frame.y)); }
export fn torus_vector(v: vec2f, frame: Basis) -> vec3f { return frame.x*v.x+frame.y*v.y; }
export fn torus_angles(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(minimum_image(b.x-a.x,PI),minimum_image(b.y-a.y,PI));
}
export fn torus_connection(a: vec2f, b: vec2f) -> f32 {
  let change=torus_angles(a,b);
  return change.y*sin(a.x+change.x*0.5)*torus_sinc(change.x*0.5);
}
export fn torus_relation(p: vec3f, q: vec3f, radius: f32, major: f32) -> TorusRelation {
  let originChart=torus_chart(p,major); let targetChart=torus_chart(q,major);
  let change=torus_angles(originChart,targetChart);
  let middle=vec2f(radius*change.x,(major+radius*cos(originChart.x+change.x*0.5))*change.y);
  let firstHalf=change.y*0.5*sin(originChart.x+change.x*0.25)*torus_sinc(change.x*0.25);
  return TorusRelation(torus_vector(torus_rotate(middle,-firstHalf),torus_frame(originChart)),length(middle),torus_connection(originChart,targetChart));
}
export fn torus_transport(v: vec3f, origin: vec3f, destination: vec3f, major: f32) -> vec3f {
  let originChart=torus_chart(origin,major); let targetChart=torus_chart(destination,major);
  return torus_vector(torus_rotate(torus_components(v,torus_frame(originChart)),torus_connection(originChart,targetChart)),torus_frame(targetChart));
}
// Second-order, speed-preserving midpoint connection integration. The candidate
// and previous vectors receive exactly the same accumulated path rotation.
export fn torus_motion(p: vec3f, displacement: vec3f, velocity: vec3f, previous: vec3f, radius: f32, major: f32) -> Motion {
  if (length(displacement)<1e-7) { return Motion(p,velocity,previous); }
  var chart=torus_chart(p,major);
  let initialFrame=torus_frame(chart);
  var moving=torus_components(displacement,initialFrame);
  let speed=length(moving);
  let steps=max(1u,u32(ceil(speed/(0.05*radius))));
  let dt=1.0/f32(steps);
  var totalAngle=0.0;
  for (var step=0u; step<steps; step++) {
    var angle=dt*sin(chart.x)*moving.y/(major+radius*cos(chart.x));
    for (var iteration=0u; iteration<8u; iteration++) {
      let middleVelocity=torus_rotate(moving,angle*0.5);
      let middleTheta=chart.x+dt*middleVelocity.x/(2.0*radius);
      let nextAngle=dt*sin(middleTheta)*middleVelocity.y/(major+radius*cos(middleTheta));
      let difference=abs(nextAngle-angle);
      angle=nextAngle;
      if (difference<1e-7) { break; }
    }
    let middleVelocity=torus_rotate(moving,angle*0.5);
    let middleTheta=chart.x+dt*middleVelocity.x/(2.0*radius);
    chart+=vec2f(dt*middleVelocity.x/radius,dt*middleVelocity.y/(major+radius*cos(middleTheta)));
    chart=vec2f(minimum_image(chart.x,PI),minimum_image(chart.y,PI));
    moving=torus_rotate(moving,angle);
    moving*=speed/max(length(moving),1e-7);
    totalAngle+=angle;
  }
  let finalFrame=torus_frame(chart);
  return Motion(torus_point(chart,radius,major),torus_vector(torus_rotate(torus_components(velocity,initialFrame),totalAngle),finalFrame),torus_vector(torus_rotate(torus_components(previous,initialFrame),totalAngle),finalFrame));
}
// Inverse of the chosen local midpoint log, for classifier-consistent disk
// contours/contact projection. This is distinct from physical geodesic motion.
export fn torus_offset(p: vec3f, displacement: vec3f, radius: f32, major: f32) -> vec3f {
  let chart=torus_chart(p,major);
  let local=torus_components(displacement,torus_frame(chart));
  var change=vec2f(local.x/radius,local.y/(major+radius*cos(chart.x)));
  for (var iteration=0u; iteration<8u; iteration++) {
    let firstHalf=change.y*0.5*sin(chart.x+change.x*0.25)*torus_sinc(change.x*0.25);
    let middle=torus_rotate(local,firstHalf);
    change=vec2f(middle.x/radius,middle.y/(major+radius*cos(chart.x+change.x*0.5)));
  }
  return torus_point(chart+change,radius,major);
}
export fn delta(p: vec3f, q: vec3f, kind: f32, periodic: f32, radius: f32, half: vec3f) -> vec3f {
  return delta_world(p,q,kind,periodic,radius,half,half.x-radius);
}
export fn delta_world(p: vec3f, q: vec3f, kind: f32, periodic: f32, radius: f32, half: vec3f, major: f32) -> vec3f {
  if (kind==4.0) { return torus_relation(p,q,radius,major).displacement; }
  if (kind==1.0) { return sphere_delta(p,q,radius); }
  if (kind==3.0) {
    let angle=minimum_image(oriented_angle(q.z,q.x)-oriented_angle(p.z,p.x),PI);
    return cylinder_tangent(p)*radius*angle+vec3f(0.0,q.y-p.y,0.0);
  }
  var d=q-p;
  if (kind==2.0) { d.y=0.0; }
  for (var axis=0u; axis<3u; axis++) {
    if (periodic_axis(kind,axis,periodic)) { d[axis]=minimum_image(d[axis],half[axis]); }
  }
  return d;
}
export fn surface_transport(v: vec3f, origin: vec3f, destination: vec3f, kind: f32, major: f32) -> vec3f {
  if (kind==1.0) { return transport(v,origin,destination); }
  if (kind==3.0) { return cylinder_tangent(destination)*dot(v,cylinder_tangent(origin))+vec3f(0.0,v.y,0.0); }
  if (kind==4.0) { return torus_transport(v,origin,destination,major); }
  return tangent(v,world_normal(destination,kind,major));
}
export fn neighbor_velocity(v: vec3f, origin: vec3f, destination: vec3f, kind: f32, major: f32) -> vec3f {
  if (kind>0.5) { return surface_transport(v,origin,destination,kind,major); }
  return v;
}
export fn sphere_advance(p: vec3f, velocity: vec3f, dt: f32, radius: f32) -> vec3f {
  let speed=length(velocity);
  if (speed<1e-7) { return safe_unit(p)*radius; }
  let angle=speed*dt/radius;
  return radius*(safe_unit(p)*cos(angle)+safe_unit(velocity)*sin(angle));
}
// Unbounded intrinsic exponential. Physical boundaries are applied by the solver;
// rendering clips bounded disks instead of reflecting their geometry.
export fn surface_advance(p: vec3f, displacement: vec3f, kind: f32, radius: f32, major: f32) -> vec3f {
  if (kind==4.0) { return torus_motion(p,displacement,vec3f(0.0),vec3f(0.0),radius,major).position; }
  if (kind==1.0) { return sphere_advance(p,displacement,1.0,radius); }
  if (kind==3.0) {
    let angle=oriented_angle(p.z,p.x)+dot(displacement,cylinder_tangent(p))/radius;
    return vec3f(radius*cos(angle),p.y+displacement.y,radius*sin(angle));
  }
  return vec3f(p.x+displacement.x,0.0,p.z+displacement.z);
}
export fn surface_lift(p: vec3f, kind: f32, radius: f32, lift: f32, major: f32) -> vec3f {
  if (kind==4.0) {
    let radial=safe_unit(vec3f(p.x,0.0,p.z));
    return radial*major+world_normal(p,kind,major)*(radius+lift);
  }
  if (kind==1.0) { return safe_unit(p)*(radius+lift); }
  if (kind==3.0) {
    let n=world_normal(p,kind,major);
    return vec3f(n.x*(radius+lift),p.y,n.z*(radius+lift));
  }
  return vec3f(p.x,lift,p.z);
}
export fn surface_offset(p: vec3f, displacement: vec3f, kind: f32, radius: f32, major: f32) -> vec3f {
  if (kind==4.0) { return torus_offset(p,displacement,radius,major); }
  return surface_advance(p,displacement,kind,radius,major);
}
export fn surface_interpolate(p: vec3f, q: vec3f, weight: f32, kind: f32, radius: f32, major: f32) -> vec3f {
  if (weight<=0.0) { return p; } if (weight>=1.0) { return q; }
  if (kind==4.0) { let a=torus_chart(p,major); return torus_point(a+torus_angles(a,torus_chart(q,major))*weight,radius,major); }
  return surface_advance(p,delta_world(p,q,kind,0.0,radius,vec3f(0.0),major)*weight,kind,radius,major);
}
export fn broadphase_radius(query: f32, kind: f32, radius: f32, major: f32) -> f32 {
  if (kind==4.0) { return query*(1.0+query/(2.0*(major-radius))); }
  return query;
}
export fn metric(m: Metrics, index: u32) -> f32 {
  if (index < 4u) { return m.a[index]; }
  if (index < 8u) { return m.b[index - 4u]; }
  if (index < 12u) { return m.c[index - 8u]; }
  return m.d[min(index - 12u, 3u)];
}
export fn circular_metric(index: u32) -> bool { return index == 8u || index == 10u || index == 11u || index == 12u; }
export fn normalized_metric(value: f32, lo: f32, hi: f32) -> f32 {
  return clamp((value - lo) / max(hi - lo, 1e-7), 0.0, 1.0);
}
export fn circular_mix(a: f32, b: f32, alpha: f32) -> f32 {
  if (alpha<=0.0) { return a; }
  if (alpha>=1.0) { return b; }
  var change=b-a;
  if (change>0.5) { change-=1.0; }
  if (change< -0.5) { change+=1.0; }
  return fract(a+change*alpha+1.0);
}
export fn hsl_rgb(hsl: vec3f) -> vec3f {
  let k = fract(vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0) + hsl.x) * 6.0;
  let chroma = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return hsl.z + (chroma - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
}
export fn largest_eigenvalue(a: mat3x3f) -> f32 {
  let q = (a[0].x + a[1].y + a[2].z) / 3.0;
  let diagonal = vec3f(a[0].x, a[1].y, a[2].z) - vec3f(q);
  let p = sqrt(max(0.0, (dot(diagonal, diagonal) + 2.0 * (a[0].y*a[0].y + a[0].z*a[0].z + a[1].z*a[1].z)) / 6.0));
  if (p < 1e-8) { return q; }
  let identity = mat3x3f(vec3f(1.0,0.0,0.0),vec3f(0.0,1.0,0.0),vec3f(0.0,0.0,1.0));
  let r = clamp(determinant((a - identity * q) * (1.0 / p)) * 0.5, -1.0, 1.0);
  return q + 2.0 * p * cos(acos(r) / 3.0);
}
export struct CellSpan { lo: u32, count: u32, extraLo: u32, extraCount: u32 }
// Query physical intervals, not the padded extent of ceil-sized edge cells.
// The two ranges are disjoint even when a query straddles a periodic seam.
export fn cell_span(p: f32, query: f32, minimum: f32, half: f32, width: f32, dim: u32, periodic: bool) -> CellSpan {
  let last = i32(dim) - 1;
  if (!periodic) {
    let lo = clamp(i32(floor((p-query-minimum)/width)), 0, last);
    let hi = clamp(i32(floor((p+query-minimum)/width)), 0, last);
    return CellSpan(u32(lo), u32(hi-lo+1), 0u, 0u);
  }
  if (query >= half) { return CellSpan(0u, dim, 0u, 0u); }
  let lower = p-query;
  let upper = p+query;
  if (lower < -half) {
    let hi = clamp(i32(floor((upper+half)/width)), 0, last);
    let extra = clamp(i32(floor((lower+3.0*half)/width)), 0, last);
    if (hi+1 >= extra) { return CellSpan(0u, dim, 0u, 0u); }
    return CellSpan(0u, u32(hi+1), u32(extra), u32(last-extra+1));
  }
  if (upper >= half) {
    let lo = clamp(i32(floor((lower+half)/width)), 0, last);
    let extraHi = clamp(i32(floor((upper-half)/width)), 0, last);
    if (extraHi+1 >= lo) { return CellSpan(0u, dim, 0u, 0u); }
    return CellSpan(u32(lo), u32(last-lo+1), 0u, u32(extraHi+1));
  }
  let lo = clamp(i32(floor((lower+half)/width)), 0, last);
  let hi = clamp(i32(floor((upper+half)/width)), 0, last);
  return CellSpan(u32(lo), u32(hi-lo+1), 0u, 0u);
}
export fn span_cell(span: CellSpan, index: u32) -> u32 {
  if (index < span.count) { return span.lo + index; }
  return span.extraLo + index - span.count;
}
fn interval_distance(p: f32, lo: f32, hi: f32) -> f32 {
  return max(max(lo-p,p-hi),0.0);
}
// Reject whole cells only when their clipped physical AABB cannot intersect the
// conservative query ball. Wrapped axes test neighboring domain images; the
// ceil-sized final cell never invents a padded periodic interval.
export fn cell_intersects_query(p: vec3f, cell: vec3u, minimum: vec3f, half: vec3f, width: f32, query: f32, wrapped: vec3<bool>) -> bool {
  let lo=minimum+vec3f(cell)*width;
  let hi=min(lo+vec3f(width),half);
  var distance=vec3f(0.0);
  for (var axis=0u; axis<3u; axis++) {
    var value=interval_distance(p[axis],lo[axis],hi[axis]);
    if (wrapped[axis]) {
      let period=2.0*half[axis];
      value=min(value,min(interval_distance(p[axis]-period,lo[axis],hi[axis]),interval_distance(p[axis]+period,lo[axis],hi[axis])));
    }
    distance[axis]=value;
  }
  return dot(distance,distance)<=query*query*1.00001;
}

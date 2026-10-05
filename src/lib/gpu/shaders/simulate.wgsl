import { is_surface, volume_project, volume_reflect, Particle, Metrics, PI, safe_unit, limited, tangent, basis, hash_u32, random_unit, delta_world, neighbor_velocity, surface_advance, surface_offset, surface_transport, torus_motion, torus_relation, broadphase_radius, world_normal, world_basis, periodic_axis, wrap_coordinate, reflect_coordinate, metric, circular_metric, normalized_metric, cell_span, span_cell, cell_intersects_query } from "./common.wgsl";
@id(0) override fixed_world: u32=8u;
fn world_kind() -> f32 {
  if (fixed_world<8u) { return f32(fixed_world); }
  return config[0].z;
}
@group(0) @binding(0) var<storage, read> config: array<vec4f>;
@group(0) @binding(1) var<storage, read> current: array<Particle>;
@group(0) @binding(2) var<storage, read_write> next: array<Particle>;
@group(0) @binding(3) var<storage, read> grid: array<u32>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
@group(0) @binding(5) var<storage, read> metrics: array<Metrics>;
@group(0) @binding(6) var<storage, read> species: array<vec4f>;
@group(0) @binding(7) var<storage, read> pairRules: array<vec4f>;

fn curve(row: u32, value: f32) -> f32 {
  let x = clamp(value, 0.0, 1.0) * 31.0;
  let lo = u32(floor(x));
  let hi = min(lo+1u, 31u);
  return mix(species[row+lo/4u][lo%4u], species[row+hi/4u][hi%4u], fract(x));
}
fn steering(direction: vec3f, velocity: vec3f, speed: f32, force: f32) -> vec3f {
  if (length(direction) < 1e-7) { return vec3f(0.0); }
  return limited(safe_unit(direction)*speed-velocity, force);
}
fn behavior_force(behavior: u32, displacement: vec3f, otherVelocity: vec3f, myVelocity: vec3f, normal: vec3f, speed: f32, force: f32, radius: f32, key: u32, spiralHandedness: f32) -> vec3f {
  if (behavior == 0u) { return vec3f(0.0); }
  let distance = length(displacement);
  let direction = safe_unit(displacement);
  let orbit = safe_unit(cross(normal, direction));
  let falloff = pow(clamp(1.0-distance/max(radius, 1e-6), 0.0, 1.0), 2.0);
  let separationFalloff = falloff*2.0/(distance/max(radius,1e-6)+0.5);
  var desired = vec3f(0.0);
  switch behavior {
    // Urgent escape responses add across threats; their rule bucket applies
    // the inherited 4x/5x caps before the shared acceleration limit.
    case 1u: { return -direction*separationFalloff*force; }
    case 2u: { desired = displacement+otherVelocity*min(0.5, radius/max(speed,1e-6)); }
    case 3u: {
      return (limited(displacement,force)+limited(otherVelocity*0.5-myVelocity,force*0.5))*falloff;
    }
    // Matching a velocity must preserve its magnitude, including zero.
    case 4u: { return limited(limited(otherVelocity,speed)-myVelocity,force)*falloff; }
    case 5u: { desired = orbit; }
    case 6u: { desired = displacement-safe_unit(otherVelocity)*radius*0.35; }
    case 7u: {
      let error=distance-radius*0.5;
      if (abs(error)<max(1e-5,radius*1e-5)) { return vec3f(0.0); }
      return limited(direction*clamp(error/max(radius*0.5,1e-6),-1.0,1.0)*speed-myVelocity,force)*falloff;
    }
    case 8u: { return (-direction+random_unit(key)*0.3)*separationFalloff*force*2.0; }
    case 9u: { desired = direction*1.5+orbit*select(-0.3,0.3,(key&1u)==0u); }
    case 10u: { return limited(limited(-otherVelocity,speed)-myVelocity,force)*falloff; }
    case 11u: { desired = direction*0.6+orbit*0.8*spiralHandedness; }
    default: {}
  }
  return steering(desired, myVelocity, speed, force)*falloff;
}
fn directed_response(behavior: u32, sum: vec3f, count: f32, force: f32) -> vec3f {
  if (count<=0.0) { return vec3f(0.0); }
  if (behavior==1u) { return limited(sum,force*4.0); }
  if (behavior==8u) { return limited(sum,force*5.0); }
  var cap=force;
  if (behavior==2u || behavior==5u) { cap=force*2.0; }
  if (behavior==3u || behavior==6u || behavior==7u || behavior==10u) { cap=force*1.5; }
  if (behavior==9u) { cap=force*3.5; }
  if (behavior==11u) { cap=force*3.0; }
  return limited(sum/count,cap);
}
fn obstacle_force(position: vec3f, bodySize: f32, maxForce: f32, surface: bool) -> vec3f {
  if (config[9].w < 0.5) { return vec3f(0.0); }
  var result = vec3f(0.0);
  for (var i=0u; i<u32(config[9].y); i++) {
    let shape = config[16u+2u*i];
    let size = config[17u+2u*i].xyz;
    var away = vec3f(0.0);
    var clearance = 0.0;
    if (surface) {
      let toward = delta_world(position, shape.xyz, world_kind(), config[2].w, config[1].y, config[2].xyz, config[5].z);
      away = -safe_unit(toward);
      clearance = length(toward)-select(size.x,length(size),shape.w>0.5)-bodySize;
    } else if (shape.w < 0.5) {
      let d = position-shape.xyz;
      away = safe_unit(d);
      clearance = length(d)-size.x-bodySize;
    } else {
      let d = position-shape.xyz;
      let clamped = clamp(d, -size, size);
      let outside = d-clamped;
      if (length(outside)>1e-7) {
        away = safe_unit(outside);
        clearance = length(outside)-bodySize;
      } else {
        let faces = size-abs(d);
        var axis=0u;
        if (faces.y<faces.x) { axis=1u; }
        if (faces.z<faces[axis]) { axis=2u; }
        away[axis]=select(-1.0,1.0,d[axis]>=0.0);
        clearance=-faces[axis]-bodySize;
      }
    }
    if (length(away)<1e-7) { away=world_basis(position,world_kind(),config[5].z).x; }
    let margin=max(bodySize*4.0,config[1].z*0.15);
    if (clearance<margin) { result+=away*maxForce*config[9].z*clamp(1.0-clearance/margin,0.0,4.0); }
  }
  return result;
}
fn project_obstacles(position: vec3f, bodySize: f32, surface: bool) -> vec3f {
  if (config[9].w < 0.5) { return position; }
  var p=position;
  for (var i=0u; i<u32(config[9].y); i++) {
    let shape=config[16u+2u*i];
    let size=config[17u+2u*i].xyz;
    if (surface) {
      let displacement=delta_world(shape.xyz,p,world_kind(),config[2].w,config[1].y,config[2].xyz,config[5].z);
      let radius=select(size.x,length(size),shape.w>0.5)+bodySize;
      if (length(displacement)<radius) {
        var direction=safe_unit(displacement);
        if (length(direction)<1e-7) { direction=world_basis(shape.xyz,world_kind(),config[5].z).x; }
        p=surface_offset(shape.xyz,direction*radius,world_kind(),config[1].y,config[5].z);
      }
    } else if (shape.w<0.5) {
      let displacement=p-shape.xyz;
      let radius=size.x+bodySize;
      if (length(displacement)<radius) {
        var direction=safe_unit(displacement);
        if (length(direction)<1e-7) { direction=vec3f(1.0,0.0,0.0); }
        p=shape.xyz+direction*radius;
      }
    } else {
      let displacement=p-shape.xyz;
      let extent=size+vec3f(bodySize);
      if (all(abs(displacement)<extent)) {
        let face=extent-abs(displacement);
        var axis=0u;
        if (face.y<face.x) { axis=1u; }
        if (face.z<face[axis]) { axis=2u; }
        p[axis]=shape[axis]+extent[axis]*select(-1.0,1.0,displacement[axis]>=0.0);
      }
    }
  }
  return p;
}
@compute @workgroup_size(128)
fn simulate(@builtin(global_invocation_id) invocation: vec3u) {
  if (invocation.x>=u32(config[0].x)) { return; }
  var index=invocation.x;
  let orderFlag=3u*u32(config[3].w);
  // Metadata is optional for older/small fixtures. Inactive slots or exceptionally
  // crowded cells retain the original species-coherent observer dispatch.
  if (arrayLength(&grid)>orderFlag && grid[orderFlag]==0u) { index=indices[invocation.x]; }
  let particle=current[index];
  if (particle.identity.z==0u) { next[index]=particle; return; }
  let row=particle.identity.y*64u;
  let physical=species[row];
  let flock=species[row+1u];
  let surface=is_surface(world_kind());
  let periodic=config[2].w>0.5;
  let p=particle.position.xyz;
  let velocity=particle.velocity.xyz;
  var normal=safe_unit(config[8].xyz);
  if (surface) { normal=world_normal(p,world_kind(),config[5].z); }
  if (length(normal)<1e-7) { normal=vec3f(0.0,1.0,0.0); }
  let dims=vec3u(config[3].xyz);
  let query=max(max(physical.z,physical.w*2.0),species[row+6u].x);
  var queryChord=query;
  if (world_kind()==1.0) { queryChord=2.0*config[1].y*sin(query/max(2.0*config[1].y,1e-7)); }
  let broadQuery=broadphase_radius(query,world_kind(),config[1].y,config[5].z);
  let xs=cell_span(p.x,broadQuery,config[4].x,config[2].x,config[4].w,dims.x,periodic);
  let ys=cell_span(p.y,broadQuery,config[4].y,config[2].y,config[4].w,dims.y,periodic_axis(world_kind(),1u,config[2].w));
  let zs=cell_span(p.z,broadQuery,config[4].z,config[2].z,config[4].w,dims.z,periodic);
  var separation=vec3f(0.0);
  var alignment=vec3f(0.0);
  var cohesion=vec3f(0.0);
  var flockCount=0.0;
  var collision=vec3f(0.0);
  var contacts=vec3f(0.0);
  var contactCount=0.0;
  // assertScene limits the public format to 16 species. A resolved target
  // rule owns its normalization; unrelated populations cannot dilute it.
  var directed=array<vec3f,16>();
  var directedWeights=array<f32,16>();
  var metricForces=array<vec3f,2>(vec3f(0.0),vec3f(0.0));
  var metricWeights=array<f32,2>(0.0,0.0);
  let seed=bitcast<u32>(config[14].y);
  let tick=bitcast<u32>(config[14].x);
  let rebels=species[row+2u];
  let period=max(config[1].x,rebels.z);
  let simulationTime=config[13].z;
  let cycle=floor(simulationTime/period);
  let epoch=u32(cycle);
  let selected=f32(hash_u32(particle.identity.x^seed^(epoch*0x85ebca6bu))&0xffffffu)/16777216.0<rebels.x;
  let rebellious=selected && simulationTime-cycle*period<rebels.w;
  let conforming=select(1.0,1.0-clamp(rebels.y,0.0,1.0),rebellious);
  let separationRadius=max(physical.w*2.0,physical.z*0.25);

  // These observer-wide flags change no per-neighbor rule predicates.
  var hasDirected=false;
  for (var destination=0u; destination<u32(config[0].y); destination++) {
    let activePair=pairRules[particle.identity.y*u32(config[0].y)+destination];
    hasDirected=hasDirected || (activePair.w>0.5 && activePair.x>0.5 && abs(activePair.y)>1e-7);
  }
  var hasMetric=false;
  for (var slot=0u; slot<2u; slot++) {
    let activeRow=row+38u+slot*12u;
    let activeDefinition=species[activeRow];
    hasMetric=hasMetric || (species[activeRow+1u].w>=0.5 && activeDefinition.z>=0.5 && abs(activeDefinition.w)>=1e-7);
  }

  for (var iz=0u; iz<zs.count+zs.extraCount; iz++) {
    let z=span_cell(zs,iz);
    for (var iy=0u; iy<ys.count+ys.extraCount; iy++) {
      let y=span_cell(ys,iy);
      // X-major CSR fragments retain the exact visitation/summation order.
      // A periodic seam has two disjoint strips, visited in the original order.
      for (var fragment=0u; fragment<select(1u,2u,xs.extraCount>0u); fragment++) {
        let firstX=select(xs.lo,xs.extraLo,fragment>0u);
        let countX=select(xs.count,xs.extraCount,fragment>0u);
        let firstCell=firstX+dims.x*(y+dims.y*z);
        let lastCell=firstCell+countX-1u;
        let begin=grid[u32(config[3].w)+firstCell];
        let end=grid[u32(config[3].w)+lastCell]+grid[lastCell];
        for (var neighborSlot=begin; neighborSlot<end; neighborSlot++) {
          let neighborIndex=indices[neighborSlot];
          if (neighborIndex==index) { continue; }
          let neighbor=current[neighborIndex];
          let chord=neighbor.position.xyz-p;
          if (world_kind()==1.0 && dot(chord,chord)>queryChord*queryChord*1.00001) { continue; }
          var displacement=vec3f(0.0);
          var distance=0.0;
          if (world_kind()==4.0) {
            let relation=torus_relation(p,neighbor.position.xyz,config[1].y,config[5].z);
            displacement=relation.displacement;
            distance=relation.distance;
          } else {
            displacement=delta_world(p,neighbor.position.xyz,world_kind(),config[2].w,config[1].y,config[2].xyz,config[5].z);
            distance=length(displacement);
          }
          if (distance>query) { continue; }
          var otherVelocity=vec3f(0.0);
          if (neighbor.identity.y==particle.identity.y || hasDirected || hasMetric) {
            otherVelocity=neighbor_velocity(neighbor.velocity.xyz,neighbor.position.xyz,p,world_kind(),config[5].z);
          }
          let key=hash_u32(min(particle.identity.x,neighbor.identity.x)^(max(particle.identity.x,neighbor.identity.x)*0x9e3779b9u)^seed);
          var direction=safe_unit(displacement);
          if (distance<1e-7) {
            direction=random_unit(key)*select(-1.0,1.0,particle.identity.x<neighbor.identity.x);
            if (surface) {
              direction=safe_unit(tangent(direction,normal));
              if (length(direction)<1e-7) { direction=basis(normal).x*select(-1.0,1.0,particle.identity.x<neighbor.identity.x); }
            }
          }
          let contactRadius=physical.w+species[neighbor.identity.y*64u].w;
          let collisionRadius=contactRadius*config[5].y;
          if (distance<collisionRadius) {
            collision-=direction*(1.0-distance/max(collisionRadius,1e-7));
          }
          if (distance<contactRadius) {
            contacts-=direction*(contactRadius-distance)*0.5;
            contactCount+=1.0;
          }
          if (distance<separationRadius && neighbor.identity.y==particle.identity.y) {
            separation-=direction*pow(1.0-distance/max(separationRadius,1e-7),2.0);
          }
          if (distance<physical.z && neighbor.identity.y==particle.identity.y) {
            if (length(velocity)<1e-7 || dot(safe_unit(velocity),direction)>=cos(flock.w)) {
              let weight=pow(1.0-distance/max(physical.z,1e-7),3.0);
              alignment+=otherVelocity*weight;
              cohesion+=displacement*weight;
              flockCount+=weight;
            }
          }

          let spiralHandedness=select(-1.0,1.0,((particle.identity.y+neighbor.identity.y)&1u)==0u);
          if (hasDirected) {
            let pair=pairRules[particle.identity.y*u32(config[0].y)+neighbor.identity.y];
            if (pair.w>0.5 && pair.x>0.5 && abs(pair.y)>1e-7 && distance<pair.z) {
              directed[neighbor.identity.y]+=behavior_force(u32(pair.x),displacement,otherVelocity,velocity,normal,physical.x,physical.y,pair.z,key,spiralHandedness)*pair.y;
              directedWeights[neighbor.identity.y]+=1.0;
            }
          }
          if (hasMetric) {
            for (var rule=0u; rule<2u; rule++) {
              let ruleRow=row+38u+rule*12u;
              let definition=species[ruleRow];
              let range=species[ruleRow+1u];
              if (range.w<0.5 || definition.z<0.5 || abs(definition.w)<1e-7 || distance>=range.z) { continue; }
              let source=u32(definition.x);
              var value=metric(metrics[neighborIndex],source);
              if (definition.y>0.5 && definition.y<1.5) { value=metric(metrics[index],source); }
              if (definition.y>1.5) {
                value=abs(value-metric(metrics[index],source));
                if (circular_metric(source)) { value=min(value,1.0-value); }
              }
              let mapped=curve(ruleRow+2u,normalized_metric(value,range.x,range.y));
              if (mapped<=1e-7) { continue; }
              metricForces[rule]+=behavior_force(u32(definition.z),displacement,otherVelocity,velocity,normal,physical.x,physical.y,range.z,key,spiralHandedness)*mapped*definition.w;
              metricWeights[rule]+=1.0;
            }
          }
        }
      }
    }
  }
  var acceleration=vec3f(0.0);
  if (flockCount>0.0) {
    acceleration+=limited(alignment/flockCount-velocity,physical.y)*flock.y*conforming;
    acceleration+=limited(cohesion/flockCount,physical.y)*flock.z*conforming;
  }
  acceleration+=limited(separation,physical.y*2.0)*flock.x;
  acceleration+=limited(collision,physical.y*2.0)*config[5].x;

  if (hasDirected) {
    for (var targetSpecies=0u; targetSpecies<u32(config[0].y); targetSpecies++) {
      let pair=pairRules[particle.identity.y*u32(config[0].y)+targetSpecies];
      acceleration+=directed_response(u32(pair.x),directed[targetSpecies],directedWeights[targetSpecies],physical.y);
    }
  }

  if (hasMetric) {
    for (var rule=0u; rule<2u; rule++) {
      if (metricWeights[rule]>0.0) { acceleration+=metricForces[rule]/metricWeights[rule]; }
    }
  }

  if (rebellious) { acceleration+=random_unit(hash_u32(particle.identity.x^epoch^seed))*physical.y*rebels.y*0.05; }
  acceleration+=random_unit(hash_u32(particle.identity.x^(tick*0x9e3779b9u)^seed))*config[8].w;
  if (config[6].w>0.5 && config[7].x>0.5) {
    var displacement=delta_world(p,config[6].xyz,world_kind(),config[2].w,config[1].y,config[2].xyz,config[5].z);
    var depthWeight=1.0;
    if (!surface) {
      let planeNormal=safe_unit(config[11].yzw);
      depthWeight=clamp(1.0-abs(dot(p,planeNormal)-config[12].x)/max(config[7].w,1e-7),0.0,1.0);
      displacement=tangent(displacement,planeNormal);
    }
    let distance=length(displacement);
    let radius=max(config[11].x,1e-7);
    var influence=pow(clamp(1.0-distance/radius,0.0,1.0),2.0);
    if (config[7].z>0.5) { influence=clamp(1.0-abs(distance-radius*0.7)/(radius*0.3),0.0,1.0); }
    let response=species[row+3u];
    acceleration+=(safe_unit(displacement)*response.x+safe_unit(cross(normal,displacement))*response.y)*config[7].y*physical.y*influence*depthWeight;
  }
  acceleration+=obstacle_force(p,physical.w,physical.y,surface);
  if (surface) { acceleration=tangent(acceleration,normal); }
  acceleration=limited(acceleration,physical.y);
  var newVelocity=velocity+acceleration*config[1].x;
  let cruiseSpeed=clamp(species[row+5u].y,0.0,physical.x);
  if (length(newVelocity)<cruiseSpeed) {
    var heading=safe_unit(newVelocity);
    if (length(newVelocity)<1e-7) { heading=safe_unit(velocity); }
    if (length(heading)<1e-7) {
      heading=random_unit(hash_u32(particle.identity.x^seed^(particle.identity.w*0x27d4eb2du)));
      if (surface) {
        heading=safe_unit(tangent(heading,normal));
        if (length(heading)<1e-7) { heading=basis(normal).x; }
      }
    }
    // Propulsion and steering share the same total acceleration budget.
    // A cruise target can take several ticks to reach, and force zero cannot launch.
    let targetVelocity=heading*cruiseSpeed;
    newVelocity=velocity+limited(targetVelocity-velocity,physical.y*config[1].x);
  }
  if (surface) { newVelocity=tangent(newVelocity,normal); }
  newVelocity=limited(newVelocity,physical.x);
  var correction=vec3f(0.0);
  if (contactCount>0.0) { correction=limited(contacts/contactCount,min(physical.w*0.5,physical.x*config[1].x*0.5)); }
  let movement=limited(newVelocity*config[1].x+correction,physical.x*config[1].x);
  var newPosition=p+movement;
  var previous=velocity;
  if (surface) {
    newVelocity=tangent(newVelocity,normal);
    if (world_kind()==4.0) {
      let motion=torus_motion(p,tangent(movement,normal),newVelocity,velocity,config[1].y,config[5].z);
      newPosition=project_obstacles(motion.position,physical.w,true);
      // Obstacle projection follows a separate short chart path after motion.
      newVelocity=motion.velocity; previous=motion.previousVelocity;
      if (any(newPosition!=motion.position)) {
        newVelocity=surface_transport(motion.velocity,motion.position,newPosition,world_kind(),config[5].z);
        previous=surface_transport(motion.previousVelocity,motion.position,newPosition,world_kind(),config[5].z);
      }
    } else {
      newPosition=surface_advance(p,tangent(movement,normal),world_kind(),config[1].y,config[5].z);
      newPosition=project_obstacles(newPosition,physical.w,true);
      newVelocity=surface_transport(newVelocity,p,newPosition,world_kind(),config[5].z);
      previous=surface_transport(velocity,p,newPosition,world_kind(),config[5].z);
    }
  } else { newPosition=project_obstacles(newPosition,physical.w,false); }
  // A sphere is closed. Plane/box edges and cylinder axial edges reflect with
  // exact repeated triangle-wave motion; plane periodicity excludes its zero Y extent.
  if (world_kind()>=5.0) {
    let projected=volume_project(newPosition,world_kind(),config[1].y,config[2].xyz,config[5].z,physical.w);
    if (any(projected!=newPosition)) {
      newVelocity=volume_reflect(newPosition,newVelocity,world_kind(),config[1].y,config[2].xyz,config[5].z,physical.w);
      newPosition=projected;
    }
  } else if (world_kind()!=1.0 && world_kind()!=4.0) {
    for (var axis=0u; axis<3u; axis++) {
      if (world_kind()==3.0 && axis!=1u) { continue; }
      if (world_kind()==2.0 && axis==1u) { newPosition.y=0.0; newVelocity.y=0.0; previous.y=0.0; continue; }
      let extent=config[2][axis];
      if (periodic_axis(world_kind(),axis,config[2].w)) {
        newPosition[axis]=wrap_coordinate(newPosition[axis],extent);
      } else {
        let reflected=reflect_coordinate(newPosition[axis],newVelocity[axis],max(extent-physical.w,1e-4));
        newPosition[axis]=reflected.x;
        newVelocity[axis]=reflected.y;
      }
    }
  }
  next[index]=Particle(vec4f(newPosition,1.0),vec4f(newVelocity,0.0),vec4f(previous,0.0),particle.identity);
}

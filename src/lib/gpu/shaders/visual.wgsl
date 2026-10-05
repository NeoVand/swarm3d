import { Metrics, metric, normalized_metric, circular_mix, hsl_rgb, safe_unit, PI, TAU } from "./common.wgsl";
export fn channel(base: f32, definition: vec4f, curveValue: f32, enabled: bool, circular: bool) -> f32 {
  if (!enabled || definition.x<0.0) { return base; }
  let strength=clamp(definition.w,0.0,1.0);
  if (circular) { return circular_mix(base,curveValue,strength); }
  return mix(base,curveValue,strength);
}
// The inherited palette ramps retain their original colors. Saturation and
// lightness still apply after sampling the ramp; Rainbow uses ordinary HSL.
export fn srgb_linear(color: vec3f) -> vec3f {
  return select(pow((color+vec3f(0.055))/1.055,vec3f(2.4)),color/12.92,color<=vec3f(0.04045));
}
export fn palette_color(hsl: vec3f, palette: u32) -> vec3f {
  if (palette==0u) { return srgb_linear(hsl_rgb(hsl)); }
  let t=clamp(hsl.x,0.0,1.0);
  var rgb=vec3f(0.0);
  if (palette==1u) {
    let colors=array<vec3f,7>(vec3f(0.9,0.2,0.3),vec3f(0.95,0.6,0.1),vec3f(0.95,0.9,0.2),vec3f(0.2,0.8,0.4),vec3f(0.2,0.6,0.9),vec3f(0.6,0.3,0.8),vec3f(0.9,0.2,0.3));
    let x=t*6.0;
    let index=min(u32(floor(x)),5u);
    rgb=mix(colors[index],colors[index+1u],smoothstep(0.85,1.0,fract(x)));
  } else if (palette==2u) {
    let colors=array<vec3f,7>(vec3f(0.3,0.42,0.78),vec3f(0.25,0.65,0.7),vec3f(0.35,0.75,0.55),vec3f(0.92,0.78,0.35),vec3f(0.88,0.5,0.45),vec3f(0.65,0.42,0.65),vec3f(0.3,0.42,0.78));
    let x=t*6.0;
    let index=min(u32(floor(x)),5u);
    rgb=mix(colors[index],colors[index+1u],x-f32(index));
  } else if (palette==3u) {
    let colors=array<vec3f,5>(vec3f(0.2,0.4,0.9),vec3f(0.3,0.8,0.9),vec3f(0.95,0.95,0.9),vec3f(0.95,0.6,0.2),vec3f(0.9,0.2,0.2));
    let x=t*4.0;
    let index=min(u32(floor(x)),3u);
    rgb=mix(colors[index],colors[index+1u],x-f32(index));
  } else {
    let brightness=0.4+t*0.6;
    rgb=vec3f(brightness,brightness*0.95,brightness*0.9);
  }
  let luminance=dot(rgb,vec3f(0.299,0.587,0.114));
  rgb=mix(vec3f(luminance),rgb,clamp(hsl.y,0.0,1.0));
  // Legacy ramp brightness scales the palette; it does not mix it with white.
  return srgb_linear(clamp(rgb*(clamp(hsl.z,0.0,1.0)*2.0),vec3f(0.0),vec3f(1.0)));
}
export fn agent_curve(row: u32, value: f32, params: ptr<storage,array<vec4f>,read>) -> f32 {
  let x=clamp(value,0.0,1.0)*31.0;
  let lo=u32(floor(x));
  let hi=min(lo+1u,31u);
  return mix((*params)[row+lo/4u][lo%4u],(*params)[row+hi/4u][hi%4u],fract(x));
}
export fn agent_color(row: u32, measured: Metrics, params: ptr<storage,array<vec4f>,read>, palette: u32) -> vec3f {
  var hsl=(*params)[row+4u].xyz;
  for (var c=0u; c<3u; c++) {
    let mapRow=row+8u+c*10u;
    let definition=(*params)[mapRow];
    var mapped=hsl[c];
    if (definition.x>=0.0) { mapped=agent_curve(mapRow+1u,normalized_metric(metric(measured,u32(definition.x)),definition.y,definition.z),params); }
    hsl[c]=channel(hsl[c],definition,mapped,(*params)[mapRow+9u].x>0.5,false);
  }
  // Static species HSL remains exactly the user's color, independent of ramps.
  let hue=(*params)[row+8u];
  let mappedHue=(*params)[row+17u].x>0.5 && hue.x>=0.0 && hue.w>0.0;
  return palette_color(hsl,select(0u,palette,mappedHue));
}
// Geometry fits one fixed-size instance. Unused triangles are degenerate.
// Forward is local +Z; body size is the collision radius, visual tip extends 2 radii.
export fn body_vertex(index: u32, shape: u32) -> vec3f {
  let triangle=index/3u;
  let corner=index%3u;
  if (shape==4u) {
    // A shallow tapered prism gives ribbons an actual edge and lit top surface,
    // using the same fixed 36 vertices as every other body.
    let points=array<vec3f,8>(vec3f(-0.65,-0.16,-1.2),vec3f(0.65,-0.16,-1.2),vec3f(-0.2,-0.08,1.8),vec3f(0.2,-0.08,1.8),vec3f(-0.65,0.16,-1.2),vec3f(0.65,0.16,-1.2),vec3f(-0.2,0.08,1.8),vec3f(0.2,0.08,1.8));
    let ids=array<u32,36>(0u,1u,2u,1u,3u,2u,4u,6u,5u,6u,7u,5u,0u,4u,1u,4u,5u,1u,2u,3u,6u,3u,7u,6u,0u,2u,4u,2u,6u,4u,1u,5u,3u,5u,7u,3u);
    return points[ids[index]];
  }
  if (shape==3u) {
    // A twelve-face rounded bead uses the whole existing vertex budget.
    let side=triangle%6u;
    let angle=TAU*f32(side)/6.0;
    let nextAngle=TAU*f32(side+1u)/6.0;
    let a=vec3f(cos(angle),0.0,sin(angle));
    let b=vec3f(cos(nextAngle),0.0,sin(nextAngle));
    if (triangle<6u) {
      if (corner==0u) { return b; }
      if (corner==1u) { return a; }
      return vec3f(0.0,1.0,0.0);
    }
    if (corner==0u) { return a; }
    if (corner==1u) { return b; }
    return vec3f(0.0,-1.0,0.0);
  }
  if (shape==1u) {
    let side=triangle%6u;
    let angle=TAU*f32(side)/6.0;
    let nextAngle=TAU*f32(side+1u)/6.0;
    let a=vec3f(cos(angle)*0.7,sin(angle)*0.7,-0.8);
    let b=vec3f(cos(nextAngle)*0.7,sin(nextAngle)*0.7,-0.8);
    if (triangle<6u) {
      if (corner==0u) { return a; }
      if (corner==1u) { return b; }
      return vec3f(0.0,0.0,2.0);
    }
    if (corner==0u) { return b; }
    if (corner==1u) { return a; }
    return vec3f(0.0,0.0,-0.8);
  }
  if (triangle>=8u) { return vec3f(0.0); }
  let side=triangle%4u;
  let angle=TAU*f32(side)/4.0;
  let nextAngle=TAU*f32(side+1u)/4.0;
  let width=select(0.7,1.0,shape==3u);
  let rear=select(-1.0,-1.6,shape==2u);
  let front=select(2.0,1.0,shape==3u);
  var a=vec3f(cos(angle)*width,sin(angle)*width,0.0);
  var b=vec3f(cos(nextAngle)*width,sin(nextAngle)*width,0.0);
  // Arrow shoulders sit behind the front tip; diamond/sphere are symmetric.
  if (shape==0u) { a.z=-0.3; b.z=-0.3; }
  if (triangle<4u) {
    if (corner==0u) { return a; }
    if (corner==1u) { return b; }
    return vec3f(0.0,0.0,front);
  }
  if (corner==0u) { return b; }
  if (corner==1u) { return a; }
  return vec3f(0.0,0.0,rear);
}
export fn sphere_point(u: f32, v: f32) -> vec3f {
  let longitude=TAU*u;
  let latitude=PI*(v-0.5);
  return vec3f(cos(latitude)*cos(longitude),sin(latitude),cos(latitude)*sin(longitude));
}
export fn sphere_vertex(index: u32, longitudeCount: u32, latitudeCount: u32) -> vec3f {
  let cell=index/6u;
  let longitude=cell%longitudeCount;
  let latitude=cell/longitudeCount;
  let offsets=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
  let uv=(vec2f(f32(longitude),f32(latitude))+offsets[index%6u])/vec2f(f32(longitudeCount),f32(latitudeCount));
  return sphere_point(uv.x,uv.y);
}

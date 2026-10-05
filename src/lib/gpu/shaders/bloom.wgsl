struct Glow { texel: vec2f }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> glow: Glow;
@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights=array<f32,3>(0.25,0.5,0.25);
  var color=vec3f(0.0);
  for (var y=-1; y<=1; y++) { for (var x=-1; x<=1; x++) {
    color+=textureSample(image,imageSampler,uv+vec2f(f32(x),f32(y))*glow.texel).rgb*weights[x+1]*weights[y+1];
  }}
  return vec4f(color,1.0);
}

struct Glow { texel: vec2f }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> glow: Glow;
@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var brightness=vec3f(0.0);
  for (var y=-1; y<=1; y+=2) { for (var x=-1; x<=1; x+=2) {
    brightness+=max(textureSample(image,imageSampler,uv+vec2f(f32(x),f32(y))*glow.texel).rgb-vec3f(0.65),vec3f(0.0));
  }}
  return vec4f(brightness*0.25,1.0);
}

struct Presentation { bloom: f32, exposure: f32 }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var glow: texture_2d<f32>;
@group(0) @binding(3) var<uniform> presentation: Presentation;
fn linear_srgb(color: vec3f) -> vec3f {
  return select(1.055*pow(color,vec3f(1.0/2.4))-vec3f(0.055),color*12.92,color<=vec3f(0.0031308));
}
@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color=textureSample(image,imageSampler,uv).rgb;
  if (presentation.bloom>0.5) { color+=textureSample(glow,imageSampler,uv).rgb*0.22; }
  color=max(color,vec3f(0.0));
  // One shared shoulder preserves linear RGB ratios; independent channel
  // compression was lifting weaker channels and washing vibrant colors gray.
  let peak=max(max(color.r,color.g),color.b);
  let shoulder=1.0-exp(-peak*max(presentation.exposure,0.0));
  color*=shoulder/max(peak,1e-7);
  return vec4f(linear_srgb(color),1.0);
}

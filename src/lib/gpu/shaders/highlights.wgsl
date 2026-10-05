struct Glow { texel: vec2f, background: vec3f, day: f32 }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> glow: Glow;
@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var brightness=vec3f(0.0);
  // Filter each source texel BEFORE decimation. Thresholding sparse bilinear
  // samples after averaging makes tiny moving agents blink across the knee.
  let dimensions=vec2i(textureDimensions(image));
  let start=vec2i(floor(uv*vec2f(dimensions)-vec2f(2.0)));
  for (var y=0; y<4; y++) { for (var x=0; x<4; x++) {
    let color=textureLoad(image,clamp(start+vec2i(x,y),vec2i(0),dimensions-vec2i(1)),0).rgb;
    let difference=abs(color-glow.background);
    let contrast=max(max(difference.r,difference.g),difference.b);
    let peak=max(max(color.r,color.g),color.b);
    // A soft knee operates on the whole color, preserving saturation. The old
    // per-channel 0.65 cutoff removed almost every ordinary shaded agent.
    let mask=smoothstep(0.015,0.10,contrast);
    let light=select(color*smoothstep(0.06,0.30,peak),max(glow.background-color,vec3f(0.0)),glow.day>0.5);
    brightness+=light*mask;
  }}
  return vec4f(brightness/16.0,1.0);
}

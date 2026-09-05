// Fragment shaders for the background canvas (GLSL ES 3.00). All share the
// same uniforms: u_res, u_time, u_c[4] (palette gradient), u_dark (0/1),
// u_mouse (0..1), u_seed. tone() keeps colours muted on dark surfaces and
// pastel on light ones so text on the glass above stays readable.
const HEAD = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 u_res; uniform float u_time; uniform vec3 u_c[4]; uniform float u_dark; uniform vec2 u_mouse; uniform float u_seed;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + vec2(17.3, 9.1); a *= .5; } return v; }
vec3 tone(vec3 c){ return u_dark > .5 ? mix(vec3(.045, .05, .08), c, .42) : mix(vec3(.985, .985, .995), c, .30); }
vec3 base(){ return u_dark > .5 ? vec3(.055, .06, .09) : vec3(.96, .965, .985); }
`;

export const SHADERS: Record<string, string> = {
  aurora: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float t = u_time * .05;
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.);
  p += (u_mouse - .5) * .06;
  float n1 = fbm(p * 1.4 + vec2(t, -t * .7) + u_seed);
  float n2 = fbm(p * 2.1 - vec2(t * .6, t * .4) + 5.2);
  float band = smoothstep(.15, .85, sin((uv.y * 2.2 + n1 * 1.6 + t * 2.) * 3.1416) * .5 + .5);
  vec3 col = mix(u_c[0], u_c[1], n1);
  col = mix(col, u_c[2], band * n2);
  col = mix(col, u_c[3], smoothstep(.55, 1., n2) * .6);
  col = tone(col);
  float vig = smoothstep(1.5, .25, length(uv - .5));
  o = vec4(mix(base(), col, .85 * vig + .15), 1.);
}`,
  mesh: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv; float ar = u_res.x / u_res.y; p.x *= ar; float t = u_time * .13;
  vec3 acc = vec3(0.); float w = 0.;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = vec2(.5 + .42 * sin(t * (.55 + fi * .12) + fi * 1.7 + u_seed), .5 + .42 * cos(t * (.47 + fi * .1) + fi * 2.3));
    c.x *= ar; c += (u_mouse - .5) * .05 * (fi + 1.);
    float d = length(p - c); float g = exp(-d * d * 2.6);
    acc += g * u_c[i - (i / 4) * 4]; w += g;
  }
  vec3 col = acc / max(w, .001);
  o = vec4(mix(base(), tone(col), .9), 1.);
}`,
  nebula: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv * vec2(u_res.x / u_res.y, 1.) * 1.8; float t = u_time * .035;
  p += (u_mouse - .5) * .08;
  vec2 q = vec2(fbm(p + t + u_seed), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 4. * q + vec2(1.7, 9.2) + t * .5), fbm(p + 4. * q + vec2(8.3, 2.8) - t * .3));
  float f = fbm(p + 4. * r);
  vec3 col = mix(u_c[0], u_c[1], clamp(f * f * 4., 0., 1.));
  col = mix(col, u_c[2], clamp(length(q), 0., 1.));
  col = mix(col, u_c[3], clamp(r.x, 0., 1.) * .7);
  o = vec4(mix(base(), tone(col), .92), 1.);
}`,
  waves: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float t = u_time * .25;
  vec3 col = mix(base(), tone(u_c[0]), .35);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float y = .2 + fi * .15 + .07 * sin(uv.x * 3. + t * (.7 + fi * .2) + fi * 1.3 + u_seed) + .035 * sin(uv.x * 7. - t * .9 + fi) + (u_mouse.y - .5) * .04;
    float d = abs(uv.y - y);
    float glow = .0035 / (d + .0035);
    col += u_c[i - (i / 4) * 4] * glow * (u_dark > .5 ? .55 : .3) * (1.1 - uv.x * .3);
  }
  o = vec4(col, 1.);
}`,
  orbs: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv; float ar = u_res.x / u_res.y; p.x *= ar; float t = u_time * .07;
  vec3 col = mix(base(), tone(u_c[0]), .3);
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec2 c = vec2(fract(sin(fi * 12.9898 + u_seed) * 43758.5) * ar, fract(sin(fi * 78.233) * 43758.5));
    c += vec2(sin(t + fi), cos(t * .8 + fi * 1.3)) * .07 + (u_mouse - .5) * .03 * fract(fi * .37);
    float rad = .05 + .07 * fract(sin(fi * 3.3) * 100.);
    float d = length(p - c);
    float a = smoothstep(rad, rad - .025, d) * .32 + .012 / (d + .012) * .18;
    col = mix(col, u_c[i - (i / 4) * 4], a * (u_dark > .5 ? .55 : .38));
  }
  o = vec4(col, 1.);
}`,
  grid: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float t = u_time * .18;
  vec3 col = mix(base(), tone(u_c[0]), .35);
  vec2 g = uv * vec2(u_res.x / u_res.y, 1.) * 12.; g.y += t; g.x += (u_mouse.x - .5) * .5;
  vec2 f = abs(fract(g) - .5);
  float line = smoothstep(.47, .5, max(f.x, f.y));
  float pulse = .5 + .5 * sin(t * 2. + uv.x * 4. + u_seed);
  col += line * mix(u_c[1], u_c[2], pulse) * (u_dark > .5 ? .45 : .22) * (1.05 - uv.y);
  float band = exp(-pow((uv.y - .55 + .1 * sin(t)) * 3., 2.));
  col += u_c[3] * band * (u_dark > .5 ? .1 : .06);
  o = vec4(col, 1.);
}`,
};

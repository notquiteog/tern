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
  // ---- calm ----
  mist: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv * vec2(u_res.x / u_res.y, 1.); float t = u_time * .02;
  p += (u_mouse - .5) * .02;
  float n = fbm(p * .9 + vec2(t, -t * .6) + u_seed);
  float m = fbm(p * 1.3 - vec2(t * .4, t * .3) + 3.1);
  vec3 a = mix(u_c[0], u_c[1], n);
  vec3 b = mix(u_c[2], u_c[3], m);
  vec3 col = tone(mix(a, b, smoothstep(.3, .8, m)));
  float k = u_dark > .5 ? .32 : .2;
  o = vec4(mix(base(), col, k + .14 * n), 1.);
}`,
  silk: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv * vec2(u_res.x / u_res.y, 1.); float t = u_time * .08;
  p += (u_mouse - .5) * .05;
  for (int i = 1; i < 5; i++) { float fi = float(i); p += vec2(.35 / fi * sin(fi * 2.1 * p.y + t + fi * 1.7 + u_seed), .3 / fi * cos(fi * 1.9 * p.x - t * .8 + fi)); }
  float f = .5 + .5 * sin(p.x * 3. + p.y * 2.);
  float g = .5 + .5 * cos(p.y * 4. - p.x);
  vec3 col = tone(mix(mix(u_c[0], u_c[1], f), mix(u_c[2], u_c[3], g), .5 + .5 * sin(f * 3.14 + g)));
  float sheen = pow(f, 6.) * (u_dark > .5 ? .22 : .1);
  o = vec4(mix(base(), col, .8) + sheen, 1.);
}`,
  halo: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = (uv - .5) * vec2(u_res.x / u_res.y, 1.); float t = u_time * .12;
  p -= (u_mouse - .5) * .15;
  float d = length(p);
  float breath = .9 + .1 * sin(t);
  vec3 col = base();
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float r = (.18 + fi * .17) * breath + .02 * sin(t * (1. + fi * .3) + fi * 2. + u_seed);
    float ring = exp(-pow((d - r) * 18., 2.));
    col += tone(u_c[i]) * ring * (u_dark > .5 ? .5 : .32);
  }
  col += tone(u_c[0]) * exp(-d * d * 3.) * (u_dark > .5 ? .22 : .14);
  o = vec4(col, 1.);
}`,
  horizon: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float t = u_time * .05; float ar = u_res.x / u_res.y;
  float hy = .42 + .02 * sin(t);
  vec3 sky = mix(tone(u_c[1]), tone(u_c[0]), smoothstep(hy, 1., uv.y));
  vec3 ground = mix(tone(u_c[3]), tone(u_c[2]), smoothstep(0., hy, uv.y));
  vec3 col = mix(ground, sky, smoothstep(hy - .02, hy + .02, uv.y));
  vec2 sun = vec2(.5 + (u_mouse.x - .5) * .1, hy + .12);
  float sd = length((uv - sun) * vec2(ar, 1.));
  col += tone(u_c[2]) * exp(-sd * sd * 40.) * (u_dark > .5 ? .8 : .5) + tone(u_c[1]) * exp(-sd * 3.) * .25;
  col += tone(u_c[0]) * fbm(vec2(uv.x * 6., uv.y * 30. - t * 3.) + u_seed) * (1. - smoothstep(0., hy, uv.y)) * .12;
  o = vec4(mix(base(), col, .85), 1.);
}`,
  topo: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv * vec2(u_res.x / u_res.y, 1.) * 2.2; float t = u_time * .04;
  p += (u_mouse - .5) * .1;
  float h = fbm(p + vec2(t, -t * .5) + u_seed) + .25 * fbm(p * 3. - t);
  float lines = abs(fract(h * 14.) - .5);
  float line = smoothstep(.06, .0, lines) * (1. - smoothstep(0., .015, fwidth(h) * 30.));
  vec3 fill = mix(u_c[0], u_c[1], h);
  fill = mix(fill, u_c[2], smoothstep(.55, .9, h));
  vec3 col = mix(base(), tone(fill), .5);
  col += tone(u_c[3]) * line * (u_dark > .5 ? .5 : .3);
  o = vec4(col, 1.);
}`,
  dust: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float ar = u_res.x / u_res.y; vec2 p = uv * vec2(ar, 1.); float t = u_time * .05;
  vec3 col = mix(base(), tone(u_c[0]), .22);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float scale = 6. + fl * 5.;
    vec2 q = p * scale + vec2(t * (fl + 1.) * .6, t * (fl + 1.) * .25) + (u_mouse - .5) * (fl + 1.) * .4;
    vec2 cell = floor(q), f = fract(q);
    float best = 1.; vec3 tint = vec3(0.);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h2 = vec2(hash(cell + g + u_seed), hash(cell + g + 7.3 + u_seed));
      vec2 pos = g + h2 + .1 * sin(t * 2. + h2 * 6.28);
      float d = length(f - pos);
      if (d < best) { best = d; tint = u_c[int(mod(hash(cell + g) * 4., 4.))]; }
    }
    float s = .012 + .01 * (2. - fl);
    float glow = smoothstep(s, 0., best) + .35 * exp(-best * best * 60.);
    col += tone(tint) * glow * (u_dark > .5 ? .45 : .28) / (1. + fl * .5);
  }
  o = vec4(col, 1.);
}`,
  // ---- lively ----
  liquid: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float ar = u_res.x / u_res.y; vec2 p = uv * vec2(ar, 1.); float t = u_time * .18;
  float field = 0.; vec3 acc = vec3(0.);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 c = vec2(.5 * ar + .38 * ar * sin(t * (.4 + fi * .09) + fi * 2.4 + u_seed), .5 + .38 * cos(t * (.5 + fi * .07) + fi * 1.9));
    c += (u_mouse * vec2(ar, 1.) - c) * .06 * fract(fi * .31);
    float r = .12 + .06 * sin(fi * 3.1 + t);
    float d = length(p - c);
    float f = r * r / (d * d + 1e-4);
    field += f; acc += f * u_c[i - (i / 4) * 4];
  }
  vec3 col = acc / max(field, 1e-3);
  float edge = smoothstep(.9, 1.2, field);
  float rim = smoothstep(.8, 1.0, field) * (1. - smoothstep(1.0, 1.4, field));
  vec3 outc = mix(base(), tone(col), edge * .9);
  outc += tone(u_c[3]) * rim * (u_dark > .5 ? .4 : .2);
  o = vec4(outc, 1.);
}`,
  plasma: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; vec2 p = uv * vec2(u_res.x / u_res.y, 1.) * 3.; float t = u_time * .2;
  p += (u_mouse - .5) * .3;
  float v = sin(p.x + t) + sin(p.y + t * .7) + sin(p.x + p.y + t * .5) + sin(length(p - vec2(1.5 + sin(t * .3), 1. + cos(t * .4))) * 2. - t);
  v *= .25;
  float a = .5 + .5 * sin(v * 3.14159 + u_seed);
  float b = .5 + .5 * cos(v * 3.14159 * 1.3 + 1.);
  vec3 col = mix(mix(u_c[0], u_c[1], a), mix(u_c[2], u_c[3], b), .5 + .5 * sin(v * 2. + t * .2));
  o = vec4(mix(base(), tone(col), .9), 1.);
}`,
  prism: HEAD + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res; float t = u_time * .1; float ar = u_res.x / u_res.y;
  vec2 p = uv * vec2(ar, 1.);
  float ang = .6 + .08 * sin(t * .5) + (u_mouse.x - .5) * .1;
  vec2 dir = vec2(cos(ang), sin(ang));
  float n = fbm(p * 2. + t * .3 + u_seed) * .8;
  float s = dot(p, dir) * 3. + t + n;
  float b1 = smoothstep(.45, .5, fract(s)) * smoothstep(.62, .55, fract(s));
  float b2 = smoothstep(.45, .5, fract(s * .5 + .3)) * smoothstep(.7, .6, fract(s * .5 + .3));
  float b3 = smoothstep(.4, .5, fract(s * 1.7 + .6)) * smoothstep(.6, .5, fract(s * 1.7 + .6));
  vec3 col = mix(base(), tone(u_c[0]), .2);
  col += tone(u_c[1]) * b1 * .5 + tone(u_c[2]) * b2 * .45 + tone(u_c[3]) * b3 * .35;
  col += pow(.5 + .5 * sin(s * 6.28 + n * 4.), 8.) * (u_dark > .5 ? .3 : .15);
  o = vec4(col, 1.);
}`,
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

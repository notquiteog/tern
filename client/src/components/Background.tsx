import { useEffect, useRef } from 'react';
import { getAppearance, isDark, onAppearance, type Appearance } from '../state/theme';
import { paletteByKey } from '../lib/palettes';
import { SHADERS } from '../lib/shaders';

// Full-screen WebGL2 background. Renders at reduced resolution, caps at
// 30 fps, pauses when the tab is hidden, and draws a single still frame when
// the user prefers reduced motion. Falls back to the CSS gradient in
// app.css when WebGL2 is unavailable.
export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) { canvas.style.display = 'none'; document.documentElement.dataset.webgl = 'off'; return; }
    document.documentElement.dataset.webgl = 'on';
    let program: WebGLProgram | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    let raf = 0;
    let last = 0;
    let running = true;
    let current = '';
    const start = performance.now();
    const seed = Math.random() * 100;
    const mouse = { x: 0.5, y: 0.5 };

    const vsSrc = `#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    function compile(type: number, src: string): WebGLShader | null {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) { console.warn('shader error', gl!.getShaderInfoLog(s)); gl!.deleteShader(s); return null; }
      return s;
    }
    function build(key: string) {
      const frag = SHADERS[key];
      if (!frag) { program = null; return; }
      const vs = compile(gl!.VERTEX_SHADER, vsSrc); const fs = compile(gl!.FRAGMENT_SHADER, frag);
      if (!vs || !fs) { program = null; return; }
      const prog = gl!.createProgram()!;
      gl!.attachShader(prog, vs); gl!.attachShader(prog, fs); gl!.linkProgram(prog);
      if (!gl!.getProgramParameter(prog, gl!.LINK_STATUS)) { console.warn('link error', gl!.getProgramInfoLog(prog)); program = null; return; }
      program = prog;
      gl!.useProgram(prog);
      const loc = gl!.getAttribLocation(prog, 'p');
      gl!.enableVertexAttribArray(loc);
      gl!.vertexAttribPointer(loc, 2, gl!.FLOAT, false, 0, 0);
      uniforms = { res: gl!.getUniformLocation(prog, 'u_res'), time: gl!.getUniformLocation(prog, 'u_time'), c: gl!.getUniformLocation(prog, 'u_c'), dark: gl!.getUniformLocation(prog, 'u_dark'), mouse: gl!.getUniformLocation(prog, 'u_mouse'), seed: gl!.getUniformLocation(prog, 'u_seed') };
      current = key;
    }
    function resize() {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.55;
      const w = Math.max(1, Math.floor(window.innerWidth * scale));
      const h = Math.max(1, Math.floor(window.innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl!.viewport(0, 0, w, h); }
    }
    function colors(a: Appearance): Float32Array {
      const p = paletteByKey(a.palette);
      const out = new Float32Array(12);
      p.gradient.forEach((hex, i) => { const h = hex.replace('#', ''); out[i * 3] = parseInt(h.slice(0, 2), 16) / 255; out[i * 3 + 1] = parseInt(h.slice(2, 4), 16) / 255; out[i * 3 + 2] = parseInt(h.slice(4, 6), 16) / 255; });
      return out;
    }
    let appearance = getAppearance();
    let palette = colors(appearance);
    const reduced = () => appearance.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function frame(now: number) {
      raf = 0;
      if (!running) return;
      if (!program) { schedule(); return; }
      const fps = reduced() ? 0 : 30;
      if (fps && now - last < 1000 / fps) { schedule(); return; }
      last = now;
      resize();
      gl!.useProgram(program);
      gl!.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl!.uniform1f(uniforms.time, reduced() ? 12.5 : (now - start) / 1000);
      gl!.uniform3fv(uniforms.c, palette);
      gl!.uniform1f(uniforms.dark, isDark(appearance.theme) ? 1 : 0);
      gl!.uniform2f(uniforms.mouse, mouse.x, mouse.y);
      gl!.uniform1f(uniforms.seed, seed);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      if (!reduced()) schedule();
    }
    function schedule() { if (!raf && running) raf = requestAnimationFrame(frame); }
    function apply(a: Appearance) {
      appearance = a; palette = colors(a);
      if (a.background !== current) build(a.background);
      canvas.style.display = a.background === 'none' || !program ? 'none' : '';
      last = 0; schedule();
    }
    apply(appearance);
    const off = onAppearance(apply);
    const onVis = () => { running = document.visibilityState === 'visible'; if (running) { last = 0; schedule(); } };
    const onResize = () => { last = 0; schedule(); };
    const onMove = (e: PointerEvent) => { mouse.x = e.clientX / window.innerWidth; mouse.y = 1 - e.clientY / window.innerHeight; };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
    canvas.addEventListener('webglcontextrestored', () => { running = true; build(appearance.background); schedule(); });
    return () => { running = false; if (raf) cancelAnimationFrame(raf); off(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onMove); };
  }, []);
  return <canvas ref={ref} className="bg-canvas" aria-hidden="true" />;
}

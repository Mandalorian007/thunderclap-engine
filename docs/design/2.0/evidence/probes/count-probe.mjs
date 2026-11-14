// D2: counted-work probe of TC's renderer on its own fake device (dist 1.3.0).
// Per frame: GPU commands (pass commands + queue writes + copies + submits), bytes written,
// Float32Array/ArrayBuffer constructions, performance.now/Date.now reads, held at N distinct meshes.
let f32 = 0,
  ab = 0,
  on = false;
{
  const F = Float32Array;
  globalThis.Float32Array = new Proxy(F, {
    construct(t, a, nt) {
      if (on) f32++;
      return Reflect.construct(t, a, nt);
    },
  });
}
{
  const A = ArrayBuffer;
  globalThis.ArrayBuffer = new Proxy(A, {
    construct(t, a, nt) {
      if (on) ab++;
      return Reflect.construct(t, a, nt);
    },
  });
}
let clocks = 0;
const pn = performance.now.bind(performance);
performance.now = () => {
  if (on) clocks++;
  return pn();
};
const dn = Date.now;
Date.now = () => {
  if (on) clocks++;
  return dn();
};
const D = '/Users/matthewfontana/repos/thunderclap-engine/dist/render/';
const Fk = await import(D + 'fake-gpu.js');
Fk.installGpuGlobals();
const { Renderer, Camera, Transform, VERTEX_LAYOUT_3D } = await import(D + 'index.js');
const WGSL = `
@vertex fn vs_main(in: VertexIn, inst: InstanceIn) -> VSOut { return std_vertex_3d(in, inst); }
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = in.color; o.emissive = vec4f(0.0); return o; }`;
function run(N, views) {
  const fake = Fk.createFakeDevice();
  const r = new Renderer(Fk.fakeRendererGpu(fake));
  r.resize(2360, 1640);
  const mat = r.createMaterial({ label: 'm', blend: 'opaque', wgsl: WGSL });
  const v = new Float32Array(24 * 12),
    ix = new Uint16Array(36);
  const meshes = [];
  for (let i = 0; i < N; i++)
    meshes.push(
      r.createMesh({
        vertices: v,
        indices: ix,
        layout: VERTEX_LAYOUT_3D,
        bounds: { center: [0, 0, 0], radius: 12 },
      }),
    );
  const cam = Camera.perspective((60 * Math.PI) / 180, 2360 / 1640, 0.1, 2000);
  Object.assign(cam.screen, { x: 0, y: 0, width: 2360, height: 1640 });
  cam.cull = true;
  const tr = [];
  const side = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) {
    const t = new Transform();
    t.position.x = (i % side) * 16 - side * 8;
    t.position.z = Math.floor(i / side) * 16 - side * 8;
    t.position.y = (i % 7) * 16;
    tr.push(t);
  }
  const cnt = () =>
    fake.passes.reduce((s, p) => s + p.commands.length + 2, 0) +
    fake.writes.length +
    fake.bufferCopies.length +
    fake.submits;
  const bytes = () => fake.writes.reduce((s, w) => s + w.bytes, 0);
  const W = 30,
    M = 120;
  let c0 = 0,
    b0 = 0,
    times = [];
  for (let f = 0; f < W + M; f++) {
    if (f === W) {
      c0 = cnt();
      b0 = bytes();
      f32 = 0;
      ab = 0;
      clocks = 0;
    }
    const yaw = f * 0.02;
    cam.lookAt([0, 40, 0], [Math.cos(yaw) * 100, 30, Math.sin(yaw) * 100]);
    on = f >= W;
    const t0 = pn();
    for (let e = 0; e < views; e++) {
      const frame = r.beginFrame(f / 60, 1 / 60);
      for (let i = 0; i < N; i++) frame.mesh(meshes[i], mat, tr[i]);
      r.render(frame, cam);
      r.endFrame();
    }
    on = false;
    if (f >= W) times.push(pn() - t0);
  }
  times.sort((a, b) => a - b);
  const s = r.stats;
  return {
    N,
    views,
    gpuCmdsPerFrame: +((cnt() - c0) / M).toFixed(1),
    bytesWrittenPerFrame: Math.round((bytes() - b0) / M),
    drawCalls: s.drawCalls,
    culled: s.culled,
    f32PerFrame: +(f32 / M).toFixed(2),
    arrayBuffersPerFrame: +(ab / M).toFixed(2),
    clockReadsPerFrame: +(clocks / M).toFixed(2),
    jsMsMedianFakeGpu: +times[M >> 1].toFixed(3),
    errors: fake.errors.length,
  };
}
for (const [N, v] of [
  [1500, 1],
  [6000, 1],
  [1500, 2],
])
  console.log(JSON.stringify(run(N, v)));

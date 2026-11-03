const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const {
  spherePointFromUV, sphereUVFromPoint, rotateSpherePoint, unrotateSpherePoint,
  projectSphereUV, screenToSphereUV, sphereRadius, clampSphereZoom, SPHERE_RADIUS_RATIO,
} = createTypeScriptLoader()("engine/sphereProjection.ts");
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("every sampled path position lies on the sphere, including seams and poles", () => {
  for (let i = -25; i <= 125; i++) for (let j = 0; j <= 100; j++) {
    const p = spherePointFromUV(i / 100, j / 100);
    near(Math.hypot(p.x, p.y, p.z), 1);
    const rotated = rotateSpherePoint(p, { yaw: i * 0.13, pitch: j * 0.07 });
    near(Math.hypot(rotated.x, rotated.y, rotated.z), 1);
  }
});

test("the longitude seam is continuous, not a chord through the middle", () => {
  for (const v of [0, 0.1, 0.5, 0.9, 1]) {
    const a = spherePointFromUV(0, v), b = spherePointFromUV(1, v);
    near(a.x, b.x); near(a.y, b.y); near(a.z, b.z);
    const before = spherePointFromUV(0.999, v), after = spherePointFromUV(1.001, v);
    assert.ok(Math.hypot(before.x - after.x, before.y - after.y, before.z - after.z) < 0.013);
  }
});

test("rotation inverse is exact and preserves the original UV", () => {
  for (const rotation of [{ yaw: 0, pitch: 0 }, { yaw: 1.1, pitch: -0.8 }, { yaw: 71.5, pitch: 4.1 }]) {
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
      const p = spherePointFromUV(i / 10, j / 10);
      const restored = unrotateSpherePoint(rotateSpherePoint(p, rotation), rotation);
      near(p.x, restored.x); near(p.y, restored.y); near(p.z, restored.z);
      const uv = sphereUVFromPoint(restored);
      near(uv.u, i / 10); near(uv.v, j / 10);
    }
  }
});

test("opaque globe hides the back hemisphere and all picks use the near surface", () => {
  const rotation = { yaw: 0, pitch: 0 };
  assert.equal(projectSphereUV({ u: 0, v: 0.5 }, rotation, 1000, 800), null);
  assert.deepEqual(projectSphereUV({ u: 0.5, v: 0.5 }, rotation, 1000, 800), { x: 500, y: 400, z: 1 });
  assert.deepEqual(screenToSphereUV(500, 400, 1000, 800, rotation), { u: 0.5, v: 0.5 });
  assert.equal(screenToSphereUV(500 + sphereRadius(1000, 800) + 0.01, 400, 1000, 800, rotation), null);
  assert.equal(screenToSphereUV(0, 0, 1000, 800, rotation), null);
  assert.equal(screenToSphereUV(NaN, 400, 1000, 800, rotation), null);
  assert.equal(screenToSphereUV(0, 0, 0, 0, rotation), null);
});

test("rotated surface projection and screen hit testing agree at every viewport size", () => {
  for (const [width, height] of [[1280, 800], [390, 620], [400, 400]]) {
    for (const zoom of [0.75, 1, 1.35]) for (const rotation of [{ yaw: 0, pitch: 0 }, { yaw: -2.2, pitch: 0.7 }]) {
      for (let i = 1; i < 20; i++) for (let j = 1; j < 10; j++) {
        const uv = { u: i / 20, v: j / 10 };
        const screen = projectSphereUV(uv, rotation, width, height, zoom);
        if (!screen || screen.z < 0.00001) continue;
        const hit = screenToSphereUV(screen.x, screen.y, width, height, rotation, zoom);
        assert.ok(hit);
        near(hit.u, uv.u, 1e-8); near(hit.v, uv.v, 1e-8);
      }
    }
  }
});

test("globe zoom is bounded and invalid preferences are safe", () => {
  assert.equal(clampSphereZoom(0), 0.75);
  assert.equal(clampSphereZoom(100), 1.35);
  assert.equal(clampSphereZoom(NaN), 1);
  assert.equal(clampSphereZoom(Infinity), 1);
  near(sphereRadius(1000, 800), 376);
});

test("default globe fills 94 percent of the smaller viewport side without clipping", () => {
  assert.equal(SPHERE_RADIUS_RATIO, 0.47);
  for (const [width, height] of [[1280, 800], [390, 321], [320, 220], [600, 600]]) {
    const diameter = sphereRadius(width, height) * 2;
    near(diameter / Math.min(width, height), 0.94);
    assert.ok(diameter < width && diameter < height);
    assert.ok(diameter > Math.min(width, height) * 0.9);
  }
});

function mockGPU() {
  const calls = [];
  let objectId = 0;
  const constants = ["VERTEX_SHADER", "FRAGMENT_SHADER", "COMPILE_STATUS", "LINK_STATUS", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "TEXTURE_MAG_FILTER", "TEXTURE_WRAP_S", "TEXTURE_WRAP_T", "LINEAR", "REPEAT", "CLAMP_TO_EDGE", "DEPTH_TEST", "BLEND", "COLOR_BUFFER_BIT", "TEXTURE0", "UNPACK_FLIP_Y_WEBGL", "UNPACK_PREMULTIPLY_ALPHA_WEBGL", "RGBA", "UNSIGNED_BYTE", "TRIANGLES"];
  const gl = Object.fromEntries(constants.map(name => [name, name]));
  for (const name of ["shaderSource", "compileShader", "deleteShader", "attachShader", "linkProgram", "deleteProgram", "bindTexture", "texParameteri", "disable", "viewport", "clearColor", "clear", "useProgram", "bindVertexArray", "activeTexture", "pixelStorei", "texImage2D", "texSubImage2D", "uniform1i", "uniform2f", "uniform1f", "drawArrays", "deleteTexture", "deleteVertexArray"]) {
    gl[name] = (...args) => { calls.push({ name, args }); };
  }
  for (const name of ["createShader", "createProgram", "createTexture", "createVertexArray"]) {
    gl[name] = (...args) => { const result = { id: ++objectId, type: name, args }; calls.push({ name, args, result }); return result; };
  }
  gl.getShaderParameter = () => true;
  gl.getProgramParameter = () => true;
  gl.getUniformLocation = (_program, name) => name;
  const canvas = {
    width: 1, height: 1, style: {},
    getContext: (...args) => { calls.push({ name: "getContext", args }); return gl; },
  };
  const { SphereRenderer } = createTypeScriptLoader()("render/sphereRenderer.ts");
  return { renderer: new SphereRenderer(canvas), canvas, calls, named: name => calls.filter(call => call.name === name) };
}

test("sphere renderer allocates atlas storage only when its size changes", () => {
  const gpu = mockGPU();
  const atlas = { width: 2048, height: 1024 };
  gpu.renderer.resize(800, 600, 2);
  gpu.renderer.draw(atlas, { yaw: 0, pitch: 0 });
  gpu.renderer.draw(atlas, { yaw: 1, pitch: 0.4 });
  assert.equal(gpu.named("texImage2D").length, 1);
  assert.equal(gpu.named("texSubImage2D").length, 1);
  assert.equal(gpu.canvas.width, 1600);
  assert.equal(gpu.canvas.height, 1200);
  assert.equal(gpu.canvas.style.width, "800px");
  assert.equal(gpu.canvas.style.height, "600px");
  near(gpu.named("uniform1f").at(-1).args[1], sphereRadius(800, 600) * 2);
  // Camera/viewport resizes do not reallocate an unchanged source atlas.
  gpu.renderer.resize(390, 620, 4);
  gpu.renderer.draw(atlas, { yaw: 1, pitch: 0.4 }, 1.2);
  assert.equal(gpu.canvas.width, 780, "mobile DPR is capped at two");
  assert.equal(gpu.named("texImage2D").length, 1);
  assert.equal(gpu.named("texSubImage2D").length, 2);
  atlas.width = 1024; atlas.height = 512;
  gpu.renderer.draw(atlas, { yaw: 0, pitch: 0 });
  assert.equal(gpu.named("texImage2D").length, 2);
  assert.equal(gpu.named("drawArrays").length, 4);
});

test("sphere upload/picking share top-left atlas coordinates and opaque front-surface compositing", () => {
  const gpu = mockGPU();
  gpu.renderer.resize(800, 600, 1);
  gpu.renderer.draw({ width: 1024, height: 512 }, { yaw: 0, pitch: 0 });
  assert.deepEqual(gpu.named("pixelStorei").map(call => call.args), [
    ["UNPACK_FLIP_Y_WEBGL", false], ["UNPACK_PREMULTIPLY_ALPHA_WEBGL", true],
  ]);
  assert.ok(gpu.named("disable").some(call => call.args[0] === "BLEND"));
  const northernPixel = projectSphereUV({ u: 0.5, v: 0.25 }, { yaw: 0, pitch: 0 }, 800, 600);
  const hit = gpu.renderer.hitUV(northernPixel.x, northernPixel.y, { yaw: 0, pitch: 0 });
  near(hit.u, 0.5); near(hit.v, 0.25);
  const fragment = gpu.named("shaderSource").find(call => call.args[0].args[0] === "FRAGMENT_SHADER").args[1];
  assert.match(fragment, /vec3 normal = vec3\(p, sqrt\(max\(0\.0, 1\.0 - r2\)\)\)/, "only the near hemisphere is sampled");
  assert.match(fragment, /paint\.rgb \+ surface \* \(1\.0 - paint\.a\)/, "paint is composited over the solid globe, not an alpha hole");
  assert.match(fragment, /vec4\(color \* coverage, coverage\)/, "only the antialiased silhouette changes output alpha");
  assert.match(fragment, /angularDelta\(local, dFdx\(local\)\)/, "grid derivatives remain continuous across the longitude seam");
});

test("sphere renderer disposes GPU resources once and no longer uploads or draws", () => {
  const gpu = mockGPU();
  gpu.renderer.draw({ width: 512, height: 256 }, { yaw: 0, pitch: 0 });
  gpu.renderer.dispose();
  gpu.renderer.dispose();
  gpu.renderer.draw({ width: 512, height: 256 }, { yaw: 0, pitch: 0 });
  assert.equal(gpu.named("deleteTexture").length, 1);
  assert.equal(gpu.named("deleteVertexArray").length, 1);
  assert.equal(gpu.named("deleteProgram").length, 1);
  assert.equal(gpu.named("deleteShader").length, 2, "linked shaders are released immediately");
  assert.equal(gpu.named("drawArrays").length, 1);
  assert.equal(gpu.named("texImage2D").length, 1);
  assert.equal(gpu.named("texSubImage2D").length, 0);
});

test("surface uses an explicit bright dot lattice with bounded seam-safe footprints and no polar stack", () => {
  const gpu = mockGPU();
  const fragment = gpu.named("shaderSource").find(call => call.args[0].args[0] === "FRAGMENT_SHADER").args[1];
  assert.match(fragment, /float dotRows = 32\.0/);
  assert.match(fragment, /float dotV = \(dotRow \+ 0\.5\) \/ dotRows/, "dot rows cannot land at a singular pole");
  assert.match(fragment, /dotColumns = max\(6\.0, floor\(64\.0 \* sin\(dotV \* PI\) \+ 0\.5\)\)/, "columns thin out near poles");
  assert.match(fragment, /dotFootprint = clamp\(uvFootprint, vec2\(0\.000001\), vec2\(0\.16 \/ dotColumns, 0\.16 \/ dotRows\)\)/, "grazing derivatives cannot fuse dots into bands");
  assert.match(fragment, /vec2 dotDistance = vec2\(dotU, abs\(uv\.y - dotV\)\) \/ dotFootprint/);
  assert.match(fragment, /uvFootprint = max\(abs\(angularDelta\(local, dFdx\(local\)\)\)/, "dots share continuous 3D derivatives, not an atan seam jump");
  assert.match(fragment, /sqrt\(max\(0\.00001, 1\.0 - point\.y \* point\.y\)\)/, "latitude derivatives remain finite");
  assert.match(fragment, /vec3\(0\.19, 0\.47, 0\.49\) \* pointLattice \* pointDepth/, "readable mint point surface, separate from artwork pigments");
  assert.match(fragment, /pointDepth = 0\.38 \+ 0\.62 \* sqrt\(max\(0\.0, normal\.z\)\)/, "receding dots fade without disappearing entirely");
  assert.match(fragment, /paint\.rgb \+ surface \* \(1\.0 - paint\.a\)/, "the brighter globe cannot bleach opaque brush paint");
  gpu.renderer.dispose();
});

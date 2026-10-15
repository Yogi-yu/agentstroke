const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const ts = require("typescript");

// Load the small, pure rendering modules without emitting files, starting a
// Next server or adding a test-only transpiler dependency.
function createTypeScriptLoader(root = path.resolve(__dirname, "..")) {
  const cache = new Map();

  function resolveFile(request) {
    const candidates = [request, `${request}.ts`, `${request}.tsx`, path.join(request, "index.ts")];
    const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!file) throw new Error(`Cannot resolve test module: ${request}`);
    return file;
  }

  function load(request) {
    const file = resolveFile(path.resolve(root, request));
    if (cache.has(file)) return cache.get(file).exports;
    const nativeRequire = createRequire(file);
    if (!/\.tsx?$/.test(file)) return nativeRequire(file);
    const module = { exports: {} };
    cache.set(file, module);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const localRequire = (name) => {
      if (name.startsWith("@/")) return load(path.join(root, name.slice(2)));
      if (name.startsWith(".")) return load(path.resolve(path.dirname(file), name));
      return nativeRequire(name);
    };
    new Function("require", "module", "exports", "__filename", "__dirname", compiled)(
      localRequire, module, module.exports, file, path.dirname(file),
    );
    return module.exports;
  }

  return load;
}

module.exports = { createTypeScriptLoader };

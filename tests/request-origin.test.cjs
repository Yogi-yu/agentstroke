const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const load = createTypeScriptLoader();
const { isSameOriginRequest } = load("lib/requestOrigin.ts");

function request({ url = "http://127.0.0.1:3000/api/skyBatch", origin, host, site, forwardedHost } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  if (site !== undefined) headers["sec-fetch-site"] = site;
  if (forwardedHost !== undefined) headers["x-forwarded-host"] = forwardedHost;
  return new Request(url, { method: "POST", headers, body: "{}" });
}

test("same-site requests use the public Host instead of Next's internal binding address", () => {
  for (const binding of ["127.0.0.1", "0.0.0.0", "[::]"]) {
    assert.equal(isSameOriginRequest(request({ url: `http://${binding}:3000/api/skyBatch`, host: "localhost:3000", origin: "http://localhost:3000", site: "same-origin" })), true, binding);
  }
  assert.equal(isSameOriginRequest(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" })), true);
});

test("missing Host falls back to Request.url and absent Origin retains existing non-browser behavior", () => {
  assert.equal(isSameOriginRequest(request({ origin: "http://127.0.0.1:3000" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "http://localhost:3000" })), false);
  assert.equal(isSameOriginRequest(request()), true);
  assert.equal(isSameOriginRequest(request({ host: "localhost:3000", site: "none" })), true);
});

test("host casing and default ports normalize without changing authority semantics", () => {
  const allowed = [
    { url: "http://127.0.0.1/api/skyBatch", host: "LOCALHOST:80", origin: "http://localhost" },
    { url: "http://127.0.0.1/api/skyBatch", host: "localhost", origin: "http://LOCALHOST:80" },
    { url: "https://127.0.0.1/api/skyBatch", host: "EXAMPLE.COM:443", origin: "https://example.com" },
    { url: "https://127.0.0.1/api/skyBatch", host: "example.com", origin: "https://EXAMPLE.COM:443" },
    { host: "[::1]:3000", origin: "http://[::1]:3000" },
  ];
  for (const item of allowed) assert.equal(isSameOriginRequest(request(item)), true, JSON.stringify(item));
});

test("cross-site fetch metadata rejects even a matching or missing Origin", () => {
  assert.equal(isSameOriginRequest(request({ host: "localhost:3000", origin: "http://localhost:3000", site: "cross-site" })), false);
  assert.equal(isSameOriginRequest(request({ site: "cross-site" })), false);
});

test("different host, port, scheme and lookalike authorities remain rejected", () => {
  for (const origin of [
    "http://evil.example:3000", "http://localhost:3001", "https://localhost:3000",
    "http://127.0.0.1:3000", "http://localhost.evil.example:3000", "http://sub.localhost:3000",
  ]) {
    assert.equal(isSameOriginRequest(request({ host: "localhost:3000", origin, site: "same-origin" })), false, origin);
  }
});

test("Origin must be a single serialized HTTP(S) origin, not a URL with extra components", () => {
  for (const origin of [
    "null", "", "not a URL", "localhost:3000", "//localhost:3000", "http:localhost:3000",
    "ftp://localhost:3000", "file://localhost:3000", "http://user@localhost:3000",
    "http://user:pass@localhost:3000", "http://localhost:3000/", "http://localhost:3000/path",
    "http://localhost:3000?query=1", "http://localhost:3000#fragment",
    "http://localhost:3000?", "http://localhost:3000#",
    "http://localhost:3000,http://evil.example", "http://localhost:3000 http://evil.example",
  ]) {
    assert.equal(isSameOriginRequest(request({ host: "localhost:3000", origin })), false, JSON.stringify(origin));
  }
});

test("malformed Host headers fail closed instead of falling back to the internal URL", () => {
  for (const host of [
    "", "http://127.0.0.1:3000", "user@127.0.0.1:3000", "127.0.0.1:3000/path",
    "127.0.0.1:3000?query=1", "127.0.0.1:3000#fragment", "127.0.0.1:3000,evil.example",
    "127.0.0.1:65536", "127.0.0.1:invalid", "bad host:3000", "127.0.0.1:3000\\ignored",
  ]) {
    assert.equal(isSameOriginRequest(request({ host, origin: "http://127.0.0.1:3000" })), false, JSON.stringify(host));
  }
});

test("untrusted X-Forwarded-Host cannot approve or override a public Host", () => {
  assert.equal(isSameOriginRequest(request({ host: "localhost:3000", origin: "http://evil.example", forwardedHost: "evil.example" })), false);
  assert.equal(isSameOriginRequest(request({ host: "localhost:3000", origin: "http://localhost:3000", forwardedHost: "evil.example" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "http://evil.example", forwardedHost: "evil.example" })), false);
});

function guardedRoute() {
  const calls = { generator: 0, state: 0, store: 0, provider: 0 };
  const forbidden = (type) => () => { calls[type]++; throw new Error(`Unexpected ${type} access from an invalid request`); };
  load("lib/strokegen.ts").generateStroke = forbidden("generator");
  load("lib/skyBatchStore.ts").skyBatchState = forbidden("state");
  const store = load("lib/store.ts");
  store.listAgents = forbidden("store");
  store.listStrokes = forbidden("store");
  store.addStroke = forbidden("store");
  load("lib/openrouter/client.ts").hasOpenRouterKey = forbidden("provider");
  return { route: load("app/api/skyBatch/route.ts"), calls };
}

test("real route accepts legitimate origins before rejecting {} with 400, without store or model access", async () => {
  const { route, calls } = guardedRoute();
  assert.equal(globalThis.__noemaSkyBatches, undefined);
  for (const options of [
    { host: "localhost:3000", origin: "http://localhost:3000", site: "same-origin" },
    { url: "http://0.0.0.0:3000/api/skyBatch", host: "localhost:3000", origin: "http://localhost:3000" },
    { origin: "http://127.0.0.1:3000" },
    {},
  ]) {
    const response = await route.POST(request(options));
    assert.equal(response.status, 400, JSON.stringify(options));
    assert.match((await response.json()).error, /valid request ID/i);
  }
  assert.deepEqual(calls, { generator: 0, state: 0, store: 0, provider: 0 });
  assert.equal(globalThis.__noemaSkyBatches, undefined, "Malformed bodies must not initialize batch state");
});

test("real route rejects unsafe origins with 403 before parsing or touching state or paid generation", async () => {
  const { route, calls } = guardedRoute();
  assert.equal(globalThis.__noemaSkyBatches, undefined);
  for (const options of [
    { host: "localhost:3000", origin: "http://evil.example", forwardedHost: "evil.example" },
    { host: "localhost:3000", origin: "http://localhost:3000", site: "cross-site" },
    { host: "localhost:3000", origin: "null" },
    { host: "localhost:3000", origin: "http://localhost:3001" },
    { host: "127.0.0.1:3000/invalid", origin: "http://127.0.0.1:3000" },
  ]) {
    const value = request(options);
    value.json = () => { throw new Error("Unsafe origin must be rejected before reading its body"); };
    const response = await route.POST(value);
    assert.equal(response.status, 403, JSON.stringify(options));
    assert.equal((await response.json()).error, "Generation must be requested from this site.");
  }
  assert.deepEqual(calls, { generator: 0, state: 0, store: 0, provider: 0 });
  assert.equal(globalThis.__noemaSkyBatches, undefined, "Rejected origins must not initialize batch state");
});

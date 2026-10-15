const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

// Execute the actual panel with a local scroll target and mocked hooks/store.
// No browser, server, agent creation, or persisted data is touched.
function panelHarness() {
  const load = createTypeScriptLoader();
  let snapshot = {
    agents: [
      { id: "active", name: "Active", category: "coding", joined_at: 1 },
      { id: "selected", name: "Selected", category: "trading", joined_at: 1 },
    ],
    strokes: [
      { agent_id: "active", created_at: 30 },
      { agent_id: "active", created_at: 20 },
      { agent_id: "selected", created_at: 10 },
    ],
    capacity: 10, funding: false,
  };
  const slots = [];
  let cursor = 0, effects = [], heartbeat;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (value) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
    useMemo(factory) { return factory(); },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (slots[index] && same(slots[index].dependencies, dependencies)) return;
      const old = slots[index];
      slots[index] = { dependencies };
      effects.push(() => { old?.cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../components/EconomicAgentPanel.tsx"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === "react") return hooks;
    if (name === "next/link") return { default: "a" };
    if (name === "@/state/appStore") return { useApp: () => snapshot, appStore: {} };
    if (name === "@/lib/agents") return { categoryHue: () => 200, categoryLabel: (value) => value };
    if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
    return require(name);
  };
  new Function("require", "module", "exports", "setInterval", "clearInterval", compiled)(
    localRequire, module, module.exports, (callback) => { heartbeat = callback; return 1; }, () => {},
  );
  const all = (node, predicate) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
    return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
  };
  let tree, scrollTop = 200, scrollWrites = 0;
  const list = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; scrollWrites++; },
  };
  return {
    render(props = {}) {
      cursor = 0;
      tree = module.exports.default(props);
      const listElement = all(tree, (node) => /^econ-list(?: |$)/.test(node.props?.className ?? ""))[0];
      listElement.props.ref.current = list;
      const pending = effects; effects = []; pending.forEach((run) => run());
      return all(tree, (node) => Boolean(node.props?.["data-agent-id"]));
    },
    tick() { heartbeat(); },
    refresh() { snapshot = { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent })), strokes: snapshot.strokes.slice() }; },
    userScroll(value) { scrollTop = value; },
    get scrollTop() { return scrollTop; },
    get scrollWrites() { return scrollWrites; },
    close() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("selected author is first and highlighted; only author changes reset the inner list scroll", () => {
  const panel = panelHarness();
  try {
    let cards = panel.render();
    assert.deepEqual(cards.map((card) => card.props["data-agent-id"]), ["active", "selected"]);
    assert.equal(panel.scrollWrites, 0);
    cards = panel.render({ highlightedAgentId: "selected" });
    assert.equal(cards[0].props["data-agent-id"], "selected");
    assert.match(cards[0].props.className, /highlighted/);
    assert.equal(panel.scrollTop, 0);
    assert.equal(panel.scrollWrites, 1);

    panel.userScroll(120);
    panel.tick();
    panel.render({ highlightedAgentId: "selected" });
    panel.refresh();
    panel.render({ highlightedAgentId: "selected" });
    assert.equal(panel.scrollTop, 120, "Idle ticks and polling must preserve manual list scrolling");
    assert.equal(panel.scrollWrites, 1);

    cards = panel.render({ highlightedAgentId: "active" });
    assert.equal(cards[0].props["data-agent-id"], "active");
    assert.equal(panel.scrollWrites, 2);
    panel.render({ highlightedAgentId: null });
    assert.equal(panel.scrollWrites, 2, "Clearing selection must not jump the list");
  } finally { panel.close(); }
});

test("edit-locked author remains first and highlighted without enabling navigation", () => {
  const panel = panelHarness();
  try {
    const cards = panel.render({ highlightedAgentId: "selected", disabled: true });
    assert.equal(cards[0].props["data-agent-id"], "selected");
    assert.equal(cards[0].type, "div");
    assert.equal(cards[0].props["aria-disabled"], true);
    assert.match(cards[0].props.className, /highlighted.*locked/);
    assert.equal(cards[0].props.href, undefined);
  } finally { panel.close(); }
});

test("switching to a different stroke by the same author reveals that author again", () => {
  const panel = panelHarness();
  try {
    panel.render({ highlightedAgentId: "selected", selectedStrokeId: "first-stroke" });
    assert.equal(panel.scrollWrites, 1);
    panel.userScroll(150);
    panel.tick();
    panel.refresh();
    panel.render({ highlightedAgentId: "selected", selectedStrokeId: "first-stroke" });
    assert.equal(panel.scrollTop, 150);
    assert.equal(panel.scrollWrites, 1);

    const cards = panel.render({ highlightedAgentId: "selected", selectedStrokeId: "second-stroke" });
    assert.equal(cards[0].props["data-agent-id"], "selected");
    assert.equal(panel.scrollTop, 0);
    assert.equal(panel.scrollWrites, 2);
  } finally { panel.close(); }
});

test("studio derives owner from actual selected stroke and the panel never scrolls an outer container", () => {
  const studio = fs.readFileSync(path.resolve(__dirname, "../app/studio/page.tsx"), "utf8");
  const panel = fs.readFileSync(path.resolve(__dirname, "../components/EconomicAgentPanel.tsx"), "utf8");
  assert.match(studio, /highlightedAgentId=\{selectedStroke\?\.agent_id \?\? null\}/);
  assert.match(studio, /selectedStrokeId=\{selectedStroke\?\.id \?\? null\}/);
  assert.doesNotMatch(panel, /scrollIntoView|window\.scroll|document\.(?:body|documentElement)\.scroll/);
});

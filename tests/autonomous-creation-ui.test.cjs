const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const source = fs.readFileSync(path.join(__dirname, "../components/AgentCreationForm.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const fixture = { exports: {} };
new Function("require", "module", "exports", compiled)(require, fixture, fixture.exports);
const Form = fixture.exports.default;

function buttons(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props?.children)];
}

test("agent creation offers a single autonomous action with no endpoint or length controls", () => {
  const calls = [];
  const tree = Form({ agentName: "Linus", generating: false, onCreate: (...args) => calls.push(args) });
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /<input|<select|chaos|concept A|concept B/);
  assert.match(html, /where to begin, where to end, and every step in between/);
  const action = buttons(tree).find((node) => node.props.className.includes("creation-run"));
  action.props.onClick();
  assert.deepEqual(calls, [[]], "No endpoint hint is passed to the caller");
});

test("locked and busy creation cannot dispatch, and provider failures are accessible", () => {
  let calls = 0;
  for (const state of [{ generating: true }, { generating: false, disabled: true }]) {
    const tree = Form({ agentName: "Linus", onCreate: () => calls++, ...state });
    const action = buttons(tree).find((node) => node.props.className.includes("creation-run"));
    assert.equal(action.props.disabled, true);
    action.props.onClick();
  }
  assert.equal(calls, 0);
  assert.match(renderToStaticMarkup(Form({ agentName: "Linus", generating: false, error: "Model unavailable.", onCreate() {} })), /role="alert">Model unavailable/);
});

test("agent chat distinguishes autonomous work from the website's fixed example", () => {
  const { buildChatContext, buildChatMessages } = createTypeScriptLoader()("lib/openrouter/agentChat.ts");
  const ctx = buildChatContext([
    { from: "wu", to: "you", points: [{}, {}], generation_mode: "example" },
    { from: "attention", to: "silence", points: [{}, {}, {}], generation_mode: "autonomous" },
  ]);
  assert.match(ctx.recent_transitions[0], /fixed example endpoints; agent-chosen route/);
  assert.match(ctx.recent_transitions[1], /3 steps; agent-chosen endpoints and route/);
  const system = buildChatMessages({ name: "Fixture" }, ctx, "Describe your work")[0].content;
  assert.match(system, /including when to stop/);
  assert.match(system, /Do not claim a fixed example or historical endpoints were autonomous choices/);
});

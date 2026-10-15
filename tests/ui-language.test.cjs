const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

const root = path.resolve(__dirname, "..");
function sourceFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[jt]sx?$/.test(file) ? [file] : [];
  });
}
const uiFiles = [...sourceFiles("app"), ...sourceFiles("components"), "lib/skyPresentation.ts", "lib/canvasReset.ts"];
function inspect(callback) {
  for (const file of uiFiles) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => { callback(node, source, file); ts.forEachChild(node, visit); };
    visit(source);
  }
}

test("application copy and UI helpers contain no Chinese string literals or JSX text", () => {
  const violations = [];
  inspect((node, source, file) => {
    const isText = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node);
    if (!isText || !/\p{Script=Han}/u.test(node.text)) return;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${file}:${position.line + 1}`);
  });
  assert.deepEqual(violations, [], "Use English for application-owned text; do not translate stored user content.");
});

test("visible locale-sensitive formatting explicitly selects English", () => {
  const violations = [];
  inspect((node, source, file) => {
    const localeMethod = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^toLocale(?:DateString|TimeString|String)$/.test(node.expression.name.text);
    const intlFormatter = ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === "Intl"
      && /^(DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|DisplayNames)$/.test(node.expression.name.text);
    if (!localeMethod && !intlFormatter) return;
    const locale = node.arguments?.[0];
    if (locale && ts.isStringLiteral(locale) && locale.text === "en-US") return;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${file}:${position.line + 1}`);
  });
  assert.deepEqual(violations, [], "UI formatting must not inherit the browser's language.");
  const layout = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
  assert.match(layout, /<html\s+lang="en(?:-US)?"/);
});

test("new agent replies request English without rewriting historical messages", () => {
  const load = createTypeScriptLoader();
  const { buildChatMessages } = load("lib/openrouter/agentChat.ts");
  const { makeAgents } = load("lib/agents.ts");
  const originalMessage = "\u4f60\u597d";
  const originalHistory = [{ role: "user", text: "\u5386\u53f2\u6d88\u606f" }];
  const messages = buildChatMessages(makeAgents()[0], { recent_transitions: [], stroke_count: 0 }, originalMessage, originalHistory);
  assert.match(messages[0].content, /Respond only in English/);
  assert.equal(messages[1].content, originalHistory[0].text);
  assert.equal(messages.at(-1).content, originalMessage);
  assert.deepEqual(originalHistory, [{ role: "user", text: "\u5386\u53f2\u6d88\u606f" }]);
});

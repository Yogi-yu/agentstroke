const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { parseSemanticPath, semanticPathFromCompletion, classifySemanticGenerationError, isSemanticGenerationError, isSingleWordAnchor } = createTypeScriptLoader()("lib/semanticPath.ts");

const rows = [
  { anchor: "chaos", entropy: .8, confidence: .4 },
  { anchor: "pattern", entropy: .5, confidence: .6 },
  { anchor: "order", entropy: .2, confidence: .9 },
];
const legacy = { path: ["chaos", "pattern", "order"], entropy: [.8, .5, .2], confidence: [.4, .6, .9] };
const normalized = { anchors: legacy.path, entropy: legacy.entropy, confidence: legacy.confidence };
const parse = (value) => parseSemanticPath(JSON.stringify(value), "chaos", "order");
const code = (expected) => (error) => { assert.equal(error.code, expected); assert.ok(isSemanticGenerationError(error)); return true; };

test("autonomous parsing preserves chosen endpoints and every authored concept", () => {
  const steps = [
    { anchor: "invitation", entropy: .91, confidence: .18 },
    { anchor: "harbour", entropy: .42, confidence: .72 },
    { anchor: "invitation", entropy: .57, confidence: .87 },
  ];
  assert.deepEqual(parseSemanticPath(JSON.stringify({ steps })), {
    anchors: steps.map((step) => step.anchor),
    entropy: steps.map((step) => step.entropy),
    confidence: steps.map((step) => step.confidence),
  });
  assert.throws(() => parseSemanticPath(JSON.stringify({ steps }), "invitation"), code("invalid_response"));
});

test("complete rows and legacy named arrays normalize without inventing semantic data", () => {
  for (const value of [rows, { steps: rows }, { path: rows }, { semantic_path: rows }, legacy,
    { anchors: legacy.path, entropy_profile: legacy.entropy, confidence_profile: legacy.confidence },
    { semantic_path: legacy.path, entropy: legacy.entropy, confidence: legacy.confidence },
  ]) assert.deepEqual(parse(value), normalized);
  assert.deepEqual(parseSemanticPath("```json\n" + JSON.stringify({ steps: rows }) + "\n```", "chaos", "order"), normalized);
});

test("finite numeric strings/case/whitespace normalize, including exact 0 and 1", () => {
  const path = parse({ steps: [
    { anchor: " CHAOS ", entropy: " 0 ", confidence: "1" },
    { anchor: " order ", entropy: "1e-1", confidence: ".6" },
  ] });
  assert.deepEqual(path, { anchors: ["chaos", "order"], entropy: [0, .1], confidence: [1, .6] });
});

test("every position and supported response shape rejects phrases instead of rewriting them", () => {
  for (const bad of [
    "raw market noise", "two  words", "two\twords", "two\nwords", "two\u00a0words",
    "self-aware", "agent's", "signal_noise", "word2", "42", "echo.", "a/b", "a+b",
    "two\u200bwords", "café", "词语", "", "   ", "x".repeat(49), null, 123, true,
  ]) {
    assert.equal(isSingleWordAnchor(bad), false, String(bad));
    for (const index of [0, 1, 2]) {
      const changedRows = rows.map((row, i) => i === index ? { ...row, anchor: bad } : { ...row });
      const before = JSON.stringify(changedRows);
      for (const value of [
        { steps: changedRows },
        { anchors: changedRows.map(row => row.anchor), entropy: legacy.entropy, confidence: legacy.confidence },
      ]) assert.throws(() => parseSemanticPath(JSON.stringify(value)), code("invalid_response"));
      assert.equal(JSON.stringify(changedRows), before, "Validation cannot mutate source concepts");
    }
  }
});

test("single-word validation accepts harmless outer whitespace without changing internal spelling", () => {
  for (const word of ["a", "I", "wu", "you", "echo", "Silence", "API", "pneumonoultramicroscopicsilicovolcanoconiosis"]) {
    assert.equal(isSingleWordAnchor(word), true);
    assert.equal(isSingleWordAnchor(` \t${word}\n`), true);
    const result = parseSemanticPath(JSON.stringify({ steps: [
      { anchor: ` \t${word}\n`, entropy: .7, confidence: .4 },
      { anchor: "return", entropy: .3, confidence: .8 },
    ] }));
    assert.equal(result.anchors[0], word);
  }
});

test("explicit endpoint constraints cannot reintroduce phrases after parsing", () => {
  assert.throws(() => parseSemanticPath(JSON.stringify({ steps: rows }), "two words", "order"), code("invalid_response"));
  assert.throws(() => parseSemanticPath(JSON.stringify({ steps: rows }), "chaos", "two words"), code("invalid_response"));
  assert.deepEqual(parseSemanticPath(JSON.stringify({ steps: rows }), " chaos ", " order "), normalized);
});

test("invalid scalars cannot be silently coerced, defaulted, or clamped", () => {
  for (const value of [null, true, false, "", " ", "0x1", "NaN", "Infinity", "1/2", "50%", -0.1, 1.01, "-0.01", "2", {}, []]) {
    assert.throws(() => parse({ steps: rows.map((row, i) => i === 1 ? { ...row, entropy: value } : row) }), code("invalid_response"));
  }
});

test("missing/unknown/ambiguous fields, malformed anchors, endpoint changes and array mismatch reject", () => {
  const invalid = [
    null, {}, [], { steps: [] }, { steps: [rows[0]] },
    { steps: rows, note: "extra" }, { steps: rows, entropy: [1, 1, 1] },
    { steps: [{ anchor: "chaos", confidence: .5 }, rows[2]] },
    { steps: [{ ...rows[0], coordinates: [0, 0] }, rows[2]] },
    { steps: [{ ...rows[0], anchor: "" }, rows[2]] },
    { steps: [{ ...rows[0], anchor: 123 }, rows[2]] },
    { steps: [rows[0], "pattern", rows[2]] },
    { steps: [{ ...rows[0], anchor: "different" }, rows[2]] },
    { steps: [rows[0], { ...rows[2], anchor: "not order" }] },
    { ...legacy, entropy: [.8] }, { ...legacy, anchors: legacy.path },
    { ...legacy, entropy_profile: legacy.entropy }, { ...legacy, surprise: true },
    { path: ["chaos", "", "order"], entropy: [.8, .5, .2], confidence: [.4, .6, .9] },
  ];
  for (const value of invalid) assert.throws(() => parse(value), code("invalid_response"));
});

test("2–64 steps are accepted; oversize lists/anchors/output are rejected", () => {
  assert.equal(parse({ steps: [rows[0], rows[2]] }).anchors.length, 2);
  const steps64 = [rows[0], ...Array.from({ length: 62 }, () => rows[1]), rows[2]];
  assert.equal(parse({ steps: steps64 }).anchors.length, 64);
  assert.throws(() => parse({ steps: [rows[0], ...steps64] }), code("invalid_response"));
  assert.throws(() => parse({ steps: [rows[0], { ...rows[1], anchor: "x".repeat(257) }, rows[2]] }), code("invalid_response"));
  assert.throws(() => parseSemanticPath("x".repeat(32769), "chaos", "order"), code("invalid_response"));
});

test("partial JSON and unterminated strings are not salvaged; extra prose/objects reject", () => {
  for (const text of ['{"steps":[', '{"steps":[{"anchor":"cha', JSON.stringify({ steps: rows }).slice(0, -1)]) {
    assert.throws(() => parseSemanticPath(text, "chaos", "order"), code("truncated"));
  }
  for (const text of ["Here is JSON: " + JSON.stringify(legacy), JSON.stringify(legacy) + "\n{}", "{broken}", "```json\n{}", '{"path":]}']) {
    assert.throws(() => parseSemanticPath(text, "chaos", "order"), code("invalid_response"));
  }
});

test("duplicate object keys, including escaped aliases, cannot silently overwrite model data", () => {
  for (const text of [
    '{"path":["chaos","order"],"entropy":[2,2],"entropy":[0,1],"confidence":[0,1]}',
    '{"path":["chaos","order"],"entropy":[2,2],"entrop\\u0079":[0,1],"confidence":[0,1]}',
    '{"steps":[{"anchor":"chaos","entropy":2,"entropy":0,"confidence":0},{"anchor":"order","entropy":1,"confidence":1}]}',
  ]) assert.throws(() => parseSemanticPath(text, "chaos", "order"), code("invalid_response"));
});

test("refusal/content_filter/truncated finish metadata wins over an otherwise valid JSON body", () => {
  const complete = (finish_reason, message = {}) => ({ choices: [{ finish_reason, message: { content: JSON.stringify(legacy), ...message } }] });
  assert.throws(() => semanticPathFromCompletion(complete("length"), "chaos", "order"), code("truncated"));
  assert.throws(() => semanticPathFromCompletion(complete("content_filter"), "chaos", "order"), code("refused"));
  assert.throws(() => semanticPathFromCompletion(complete("stop", { refusal: "No." }), "chaos", "order"), code("refused"));
  assert.throws(() => semanticPathFromCompletion(complete("stop", { refusal: true }), "chaos", "order"), code("refused"));
  assert.throws(() => parse({ refusal: "No." }), code("refused"));
  assert.throws(() => semanticPathFromCompletion(complete("tool_calls"), "chaos", "order"), code("invalid_response"));
  assert.throws(() => semanticPathFromCompletion({ choices: [] }, "chaos", "order"), code("invalid_response"));
  assert.deepEqual(semanticPathFromCompletion(complete("stop"), "chaos", "order"), normalized);
});

test("HTTP-200 error envelopes and choice errors are classified without leaking raw messages", () => {
  for (const completion of [
    { error: { code: 429, message: "PRIVATE_PROVIDER_TEXT" } },
    { choices: [{ error: { code: 429, metadata: { error_type: "rate_limit_exceeded" }, message: "PRIVATE_PROVIDER_TEXT" }, finish_reason: "error" }] },
  ]) assert.throws(() => semanticPathFromCompletion(completion, "chaos", "order"), (error) => {
    assert.equal(error.code, "rate_limit");
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes("PRIVATE_PROVIDER_TEXT"));
    return true;
  });
  const error = classifySemanticGenerationError({ status: 404, error: { message: "PRIVATE_PROVIDER_TEXT" } }, 2);
  assert.equal(error.code, "unavailable");
  assert.equal(error.retryable, false);
  assert.equal(error.attempts, 2);
  assert.ok(!JSON.stringify(error).includes("PRIVATE_PROVIDER_TEXT"));
  assert.equal(error.cause, undefined);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");

function generator(create, model) {
  const load = createTypeScriptLoader();
  load("lib/openrouter/client.ts").getOpenRouter = () => create ? { chat: { completions: { create } } } : null;
  const agent = load("lib/agents.ts").makeAgents()[0];
  if (model) agent.model = model;
  const generate = load("lib/strokegen.ts").generateStroke;
  return { agent, run: (options = {}) => generate(agent, "chaos", "order", 1000, undefined, { requireModel: true, ...options }) };
}
const valid = { steps: [
  { anchor: "chaos", entropy: .8, confidence: .4 },
  { anchor: "emergent symmetry", entropy: .5, confidence: .6 },
  { anchor: "order", entropy: .2, confidence: .9 },
] };
const reply = (value = valid, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const isError = (code, retryable, attempts) => (error) => {
  assert.equal(error.name, "SemanticGenerationError");
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  assert.equal(error.attempts, attempts);
  assert.ok(!JSON.stringify(error).includes("PRIVATE_PROVIDER_TEXT"));
  assert.ok(!error.message.includes("PRIVATE_PROVIDER_TEXT"));
  assert.equal(error.cause, undefined);
  return true;
};

test("strict generation requires a configured real model, never a synthetic substitute", async () => {
  const attempts = [];
  await assert.rejects(generator(null).run({ onAttempt: (n) => attempts.push(n) }), isError("configuration", false, 0));
  assert.deepEqual(attempts, []);
});

test("valid request uses English row schema, abortable 25s and zero SDK retries", async () => {
  const calls = [], attempts = [];
  const instance = generator(async (...args) => { calls.push(args); return reply(); });
  const stroke = await instance.run({ onAttempt: (n) => attempts.push(n) });
  assert.deepEqual(attempts, [1]);
  assert.equal(calls.length, 1);
  const [body, options] = calls[0];
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeout, 25000);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(body.max_tokens, 1600);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.model, instance.agent.model);
  assert.ok(body.messages[0].content.includes('"steps"'));
  assert.ok(body.messages[0].content.includes("short English concept"));
  assert.equal(body.reasoning, undefined);
  assert.equal(stroke.agent_id, instance.agent.id);
  assert.equal(stroke.points[0].anchor, "chaos");
  assert.equal(stroke.points.at(-1).anchor, "order");
  // Mood resampling may repeat model anchors, but never invent CONCEPT_BANK detours.
  const modelAnchors = new Set(valid.steps.map((step) => step.anchor));
  assert.ok(stroke.points.every((point) => modelAnchors.has(point.anchor)));
});

test("legacy parallel arrays and numeric strings succeed without another request", async () => {
  let calls = 0;
  await generator(async () => { calls++; return reply({
    anchors: ["chaos", "emergent symmetry", "order"],
    entropy_profile: [".8", "5e-1", "0.2"], confidence_profile: [".4", ".6", ".9"],
  }); }).run();
  assert.equal(calls, 1);
});

test("malformed output is repaired once by the same real model, never patched locally", async () => {
  const calls = [], attempts = [];
  const invalid = { steps: [{ anchor: "chaos", entropy: .2 }, { anchor: "order", confidence: .7 }] };
  await generator(async (...args) => { calls.push(args); return reply(calls.length === 1 ? invalid : valid); })
    .run({ onAttempt: (n) => attempts.push(n) });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0].model, calls[0][0].model);
  assert.equal(calls[1][0].max_tokens, 2400);
  assert.equal(calls[1][1].timeout, 30000);
  assert.equal(calls[1][1].maxRetries, 0);
  assert.match(calls[1][0].messages[1].content, /failed validation \(invalid_response\)/);
  assert.match(calls[1][0].messages[1].content, /Previous response data:/);
});

test("Gemini retains its model with bounded reasoning and visible-output room", async () => {
  const calls = [];
  await generator(async (...args) => {
    calls.push(args);
    return calls.length === 1 ? { choices: [{ finish_reason: "length", message: { content: "" } }] } : reply();
  }, "google/gemini-2.5-pro").run();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([body]) => body.model), ["google/gemini-2.5-pro", "google/gemini-2.5-pro"]);
  assert.deepEqual(calls.map(([body]) => body.max_tokens), [2048, 3072]);
  for (const [body] of calls) assert.deepEqual(body.reasoning, { max_tokens: 512, exclude: true });
  assert.match(calls[1][0].messages[1].content, /failed validation \(truncated\)/);
});

test("complete JSON with finish_reason length is rejected rather than salvaged", async () => {
  let calls = 0;
  await assert.rejects(generator(async () => { calls++; return reply(valid, "length"); }).run(), isError("truncated", true, 2));
  assert.equal(calls, 2);
});

test("unsupported JSON mode is removed on one retry, without switching model or schema", async () => {
  const calls = [];
  await generator(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw { status: 400, error: { message: "response_format json_object is not supported PRIVATE_PROVIDER_TEXT" } };
    return reply();
  }).run();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][0].response_format, { type: "json_object" });
  assert.equal(calls[1][0].response_format, undefined);
  assert.equal(calls[1][0].model, calls[0][0].model);
});

test("transient provider/network/429 failures receive at most one bounded retry", async () => {
  for (const error of [
    { status: 500 }, { status: 503 }, { status: 429 }, { name: "APIConnectionError" },
    { name: "APIConnectionTimeoutError" }, { error: { metadata: { error_type: "provider_overloaded" } } },
  ]) {
    const calls = [];
    await generator(async (...args) => { calls.push(args); if (calls.length === 1) throw error; return reply(); }).run();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1].maxRetries, 0);
    assert.equal(calls[0][0].model, calls[1][0].model);
  }
});

test("permanent errors/refusals never retry or expose provider text", async () => {
  for (const [status, code] of [[401, "authentication"], [403, "authentication"], [402, "credits"], [404, "unavailable"], [400, "configuration"]]) {
    let calls = 0;
    await assert.rejects(generator(async () => { calls++; throw { status, message: "PRIVATE_PROVIDER_TEXT", error: { message: "PRIVATE_PROVIDER_TEXT" } }; }).run(), isError(code, false, 1));
    assert.equal(calls, 1);
  }
  for (const response of [
    { choices: [{ finish_reason: "stop", message: { refusal: "PRIVATE_PROVIDER_TEXT", content: JSON.stringify(valid) } }] },
    reply(valid, "content_filter"),
    { error: { code: 400, message: "PRIVATE_PROVIDER_TEXT", metadata: { error_type: "refusal" } } },
  ]) {
    let calls = 0;
    await assert.rejects(generator(async () => { calls++; return response; }).run(), isError("refused", false, 1));
    assert.equal(calls, 1);
  }
});

test("invalid scalar/unknown/missing/endpoint fields reject after exactly two requests", async () => {
  for (const value of [
    { path: [] },
    { path: ["chaos", "order"], entropy: [.5], confidence: [.5, .7] },
    { steps: valid.steps.map((step, i) => i === 1 ? { ...step, confidence: 1.1 } : step) },
    { steps: valid.steps.map((step, i) => i === 1 ? { ...step, extra: "invented" } : step) },
    { steps: valid.steps.map((step, i) => i === 0 ? { ...step, anchor: "different source" } : step) },
  ]) {
    let calls = 0;
    await assert.rejects(generator(async () => { calls++; return reply(value); }).run(), isError("invalid_response", true, 2));
    assert.equal(calls, 2);
  }
});

test("request deadlines abort real SDK signals at 25s and 30s; no hidden third request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls = [];
  const pending = generator((...args) => { calls.push(args); return new Promise(() => {}); }).run();
  const rejection = assert.rejects(pending, isError("timeout", true, 2));
  assert.equal(calls.length, 1);
  t.mock.timers.tick(24999);
  await flush();
  assert.equal(calls[0][1].signal.aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(600);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].timeout, 30000);
  t.mock.timers.tick(30000);
  await rejection;
  assert.equal(calls[1][1].signal.aborted, true);
  assert.equal(calls.length, 2);
});

test("Retry-After is respected and reduces remaining second-attempt budget below 30s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls = [];
  const pending = generator((...args) => {
    calls.push(args);
    if (calls.length === 1) return Promise.reject({ status: 429, headers: new Headers({ "retry-after": "35" }) });
    return new Promise(() => {});
  }).run();
  const rejection = assert.rejects(pending, isError("timeout", true, 2));
  await flush();
  t.mock.timers.tick(34999);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].timeout, 25000);
  t.mock.timers.tick(25000);
  await rejection;
  assert.equal(calls[1][1].signal.aborted, true);
});

test("Retry-After beyond total budget fails rather than retrying before the provider permits", async () => {
  let calls = 0;
  await assert.rejects(generator(async () => {
    calls++;
    throw { status: 429, headers: { "retry-after": "120" }, message: "PRIVATE_PROVIDER_TEXT" };
  }).run(), isError("rate_limit", true, 1));
  assert.equal(calls, 1);
});

test("observational callback failures cannot cause an extra paid request", async () => {
  let calls = 0;
  await generator(async () => { calls++; return reply(); }).run({ onAttempt: () => { throw Error("listener failed"); } });
  assert.equal(calls, 1);
});

const isCancellation = (error) => {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "Stroke generation was cancelled.");
  return true;
};

test("pre-aborted strict and legacy generation make zero provider calls and never fallback", async () => {
  for (const requireModel of [true, false]) {
    const controller = new AbortController();
    controller.abort("PRIVATE_ABORT_REASON");
    let calls = 0;
    const attempts = [];
    await assert.rejects(generator(async () => { calls++; return reply(); }).run({
      requireModel, signal: controller.signal, onAttempt: (n) => attempts.push(n),
    }), isCancellation);
    assert.equal(calls, 0);
    assert.deepEqual(attempts, []);
    // Cancellation also wins over missing server configuration in legacy mode.
    await assert.rejects(generator(null).run({ requireModel, signal: controller.signal }), isCancellation);
  }
});

test("external abort cancels the in-flight SDK signal without retry or legacy fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const requireModel of [true, false]) {
    const controller = new AbortController();
    const calls = [], attempts = [];
    const pending = generator((...args) => { calls.push(args); return new Promise(() => {}); }).run({
      requireModel, signal: controller.signal, onAttempt: (n) => attempts.push(n),
    });
    const rejected = assert.rejects(pending, isCancellation);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].signal.aborted, false);
    controller.abort("PRIVATE_ABORT_REASON");
    assert.equal(calls[0][1].signal.aborted, true);
    await rejected;
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(attempts, [1]);
  }
});

test("external abort interrupts transient backoff/Retry-After without starting attempt two", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const requireModel of [true, false]) {
    for (const providerError of [{ status: 503 }, { status: 429, headers: { "retry-after": "5" } }]) {
      const controller = new AbortController();
      let calls = 0;
      const attempts = [];
      const pending = generator(async () => { calls++; throw providerError; }).run({
        requireModel, signal: controller.signal, onAttempt: (n) => attempts.push(n),
      });
      const rejected = assert.rejects(pending, isCancellation);
      await flush();
      t.mock.timers.tick(200);
      await flush();
      assert.equal(calls, 1);
      controller.abort();
      await rejected;
      t.mock.timers.tick(60000);
      await flush();
      assert.equal(calls, 1);
      assert.deepEqual(attempts, [1]);
    }
  }
});

test("cancellation from attempt status prevents dispatch and late successful output cannot create artwork", async () => {
  for (const requireModel of [true, false]) {
    const beforeDispatch = new AbortController();
    let calls = 0;
    await assert.rejects(generator(async () => { calls++; return reply(); }).run({
      requireModel, signal: beforeDispatch.signal, onAttempt: () => beforeDispatch.abort(),
    }), isCancellation);
    assert.equal(calls, 0);

    const afterReply = new AbortController();
    const pending = generator(async () => { calls++; afterReply.abort(); return reply(); }).run({
      requireModel, signal: afterReply.signal,
    });
    await assert.rejects(pending, isCancellation);
    assert.equal(calls, 1);
  }
});

test("external abort listeners are removed after successful and cancelled generations", async () => {
  const { getEventListeners } = require("node:events");
  const success = new AbortController();
  await generator(async () => reply()).run({ signal: success.signal });
  assert.equal(getEventListeners(success.signal, "abort").length, 0);
  const cancelled = new AbortController();
  const pending = generator(() => new Promise(() => {})).run({ signal: cancelled.signal });
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
  const rejected = assert.rejects(pending, isCancellation);
  cancelled.abort();
  await rejected;
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
});

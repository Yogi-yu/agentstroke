const test = require("node:test");
const assert = require("node:assert/strict");
const { createTypeScriptLoader } = require("./load-typescript.cjs");
const { orderAgentsForSelection } = createTypeScriptLoader()("lib/agentListOrder.ts");

const agents = Object.freeze([
  Object.freeze({ id: "inactive", category: "growth", joined_at: 80 }),
  Object.freeze({ id: "prolific", category: "trading", joined_at: 1 }),
  Object.freeze({ id: "trading", category: "trading", joined_at: 999 }),
  Object.freeze({ id: "coding", category: "coding", joined_at: 1 }),
  Object.freeze({ id: "recent-output", category: "growth", joined_at: 1 }),
  Object.freeze({ id: "recent-join", category: "negotiation", joined_at: 100 }),
  Object.freeze({ id: "no-date", category: "ecommerce" }),
]);
const activity = new Map([
  ["prolific", Object.freeze({ count: 5, last: 10 })],
  ["trading", Object.freeze({ count: 2, last: 50 })],
  ["coding", Object.freeze({ count: 2, last: 50 })],
  ["recent-output", Object.freeze({ count: 2, last: 60 })],
]);
const ids = (items) => items.map((item) => item.id);
const defaultOrder = ["prolific", "recent-output", "coding", "trading", "recent-join", "inactive", "no-date"];

test("selected inactive author is pinned ahead of contributors while others retain activity order", () => {
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity, "inactive")), [
    "inactive", "prolific", "recent-output", "coding", "trading", "recent-join", "no-date",
  ]);
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity, "trading")), [
    "trading", "prolific", "recent-output", "coding", "recent-join", "inactive", "no-date",
  ]);
});

test("omitted, null, or missing selection retains the original activity-weighted ordering", () => {
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity)), defaultOrder);
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity, null)), defaultOrder);
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity, "deleted-author")), defaultOrder);
  assert.deepEqual(orderAgentsForSelection([], activity, "inactive"), []);
});

test("clearing selection restores default order without leaving the previous author pinned", () => {
  const selected = orderAgentsForSelection(agents, activity, "inactive");
  assert.equal(selected[0].id, "inactive");
  assert.deepEqual(ids(orderAgentsForSelection(agents, activity, null)), defaultOrder);
  assert.deepEqual(ids(orderAgentsForSelection(selected, activity, null)), defaultOrder);
});

test("sorting returns a new array and preserves roster objects and activity data", () => {
  const originalIds = ids(agents);
  const originalActivity = [...activity.entries()];
  const ordered = orderAgentsForSelection(agents, activity, "inactive");
  assert.notEqual(ordered, agents);
  assert.deepEqual(ids(agents), originalIds);
  assert.deepEqual([...activity.entries()], originalActivity);
  assert.equal(ordered[0], agents[0]);
  for (const item of ordered) assert.equal(item, agents.find((agent) => agent.id === item.id));
});

test("the same selected author remains first after refreshed objects and newer activity arrive", () => {
  const refreshedAuthor = { ...agents[0], name: "Refreshed author" };
  const newcomer = { id: "newest-author", category: "intelligence", joined_at: 200 };
  const refreshedAgents = [...agents.filter((agent) => agent.id !== "inactive"), refreshedAuthor, newcomer];
  const refreshedActivity = new Map([...activity, [newcomer.id, { count: 10, last: 200 }]]);
  const ordered = orderAgentsForSelection(refreshedAgents, refreshedActivity, "inactive");
  assert.equal(ordered[0], refreshedAuthor, "Selection follows identity rather than the previous object instance");
  assert.deepEqual(ids(ordered), [
    "inactive", "newest-author", "prolific", "recent-output", "coding", "trading", "recent-join", "no-date",
  ]);
  assert.deepEqual(ids(orderAgentsForSelection(refreshedAgents, refreshedActivity, null)), [
    "newest-author", ...defaultOrder,
  ]);
});

test("recency uses activity before joined_at, missing dates fall back to zero, and exact ties stay stable", () => {
  const roster = Object.freeze([
    Object.freeze({ id: "zero-activity", category: "coding", joined_at: 999 }),
    Object.freeze({ id: "undated", category: "trading" }),
    Object.freeze({ id: "joined-earlier", category: "coding", joined_at: 10 }),
    Object.freeze({ id: "stable-first", category: "coding", joined_at: 20 }),
    Object.freeze({ id: "stable-second", category: "coding", joined_at: 20 }),
  ]);
  const stats = new Map([["zero-activity", { count: 0, last: 0 }]]);
  assert.deepEqual(ids(orderAgentsForSelection(roster, stats)), [
    "stable-first", "stable-second", "joined-earlier", "zero-activity", "undated",
  ]);
  assert.deepEqual(ids(orderAgentsForSelection(roster, stats, "undated")), [
    "undated", "stable-first", "stable-second", "joined-earlier", "zero-activity",
  ]);
});

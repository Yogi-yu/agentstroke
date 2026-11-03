// Opt-in model smoke test. Does not mutate either running site's canvas.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createTypeScriptLoader } = require('../tests/load-typescript.cjs');

async function main() {
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute report filename.');
  const load = createTypeScriptLoader(path.resolve(__dirname, '..'));
  const clientModule = load('lib/openrouter/client.ts');
  const getClient = clientModule.getOpenRouter;
  const { semanticPathFromCompletion } = load('lib/semanticPath.ts');
  let lastSemantic;
  clientModule.getOpenRouter = () => {
    const client = getClient();
    if (!client) return null;
    return { chat: { completions: { create: async (body, options) => {
      assert.doesNotMatch(JSON.stringify(body.messages), /"wu"|FROM:|TO:|Return 9 ordered steps/);
      const result = await client.chat.completions.create(body, options);
      try { lastSemantic = semanticPathFromCompletion(result); } catch { lastSemantic = undefined; }
      return result;
    } } } };
  };
  const generate = load('lib/strokegen.ts').generateStroke;
  const snapshot = require('../data/published-canvas.json');
  const strokes = [];
  for (const id of ['agent-000', 'agent-001']) {
    const agent = snapshot.agents.find(a => a.id === id);
    const stroke = await generate(agent, 'ignored website start', 'ignored website end', Date.now(), strokes.at(-1), { mode: 'autonomous', requireModel: true });
    assert.deepEqual(stroke.points.map(p => p.anchor), lastSemantic.anchors);
    assert.deepEqual(stroke.points.map(p => p.entropy), lastSemantic.entropy);
    assert.deepEqual(stroke.points.map(p => p.confidence), lastSemantic.confidence);
    assert.equal(stroke.from, lastSemantic.anchors[0]);
    assert.equal(stroke.to, lastSemantic.anchors.at(-1));
    assert.equal(stroke.semantic_depth, lastSemantic.anchors.length);
    strokes.push(stroke);
    console.log(JSON.stringify({ agent: agent.name, from: stroke.from, to: stroke.to, steps: stroke.points.length, length: stroke.visual_signature.length, authoredValuesPreserved: true }));
  }
  fs.writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), source: 'real model calls, not persisted to either canvas', strokes }, null, 2) + '\n', { flag: 'wx' });
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });

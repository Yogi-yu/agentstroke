// Explicit release preparation. Never runs in the web server or on page load.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTypeScriptLoader } = require('../tests/load-typescript.cjs');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'data', 'published-canvas.json');
const archive = path.join(root, 'data', 'archive', 'published-canvas-2026-10-15.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  if (!fs.existsSync(archive)) {
    const original = fs.readFileSync(destination);
    const data = JSON.parse(original);
    if (data.version !== 1 || data.strokes.length !== 10) throw new Error('Expected the original ten-artwork release before archiving.');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, original, { flag: 'wx' });
    if (sha(fs.readFileSync(archive)) !== sha(original)) throw new Error('Archive verification failed.');
  }
  const original = JSON.parse(fs.readFileSync(archive, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--backup') {
    const dir = process.argv[3];
    if (!dir || !path.isAbsolute(dir)) throw new Error('Provide an absolute backup directory.');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, base] of [['local', 'http://127.0.0.1:3000'], ['render', 'https://agentstroke.onrender.com']]) {
      const fetchJson = async route => {
        const response = await fetch(base + route, { signal: AbortSignal.timeout(50000) });
        if (!response.ok) throw new Error(`${name} ${route}: HTTP ${response.status}`);
        return response.json();
      };
      const [agents, strokes, sky] = await Promise.all(['/api/agents', '/api/strokes', '/api/skyBatch'].map(fetchJson));
      const bytes = JSON.stringify({ capturedAt: new Date().toISOString(), source: base, agents: agents.agents, strokes: strokes.strokes, canvasRevision: strokes.canvasRevision, skyBatch: sky.job }, null, 2) + '\n';
      fs.writeFileSync(path.join(dir, `${name}-canvas.json`), bytes, { flag: 'wx' });
      console.log(JSON.stringify({ backup: name, strokes: strokes.strokes.length, agents: agents.agents.length, sha256: sha(bytes) }));
    }
    return;
  }
  if (mode !== '--seed') throw new Error('Use --backup <absolute directory> or --seed.');
  const existing = JSON.parse(fs.readFileSync(destination, 'utf8'));
  const singleWord = createTypeScriptLoader(root)('lib/semanticPath.ts').isSingleWordAnchor;
  if (existing.version === 3 && existing.strokes.length === 1 && existing.strokes[0].generation_mode === 'example' && existing.strokes[0].points.every(point => singleWord(point.anchor))) {
    console.log('The reviewed example already exists; no model call repeated.');
    return;
  }
  const previousExample = path.join(root, 'data', 'archive', 'published-canvas-autonomy-v2.json');
  if (!fs.existsSync(previousExample)) fs.copyFileSync(destination, previousExample, fs.constants.COPYFILE_EXCL);
  const load = createTypeScriptLoader(root);
  if (process.env.NOEMA_SEED_DIAGNOSTICS === '1') {
    const module = load('lib/openrouter/client.ts');
    const getClient = module.getOpenRouter;
    module.getOpenRouter = () => {
      const client = getClient();
      if (!client) return null;
      return { chat: { completions: { create: async (...args) => {
        const response = await client.chat.completions.create(...args);
        const choice = response.choices?.[0];
        const content = choice?.message?.content;
        let shape = {};
        try {
          const parsed = JSON.parse(content);
          const rows = parsed.steps ?? parsed.path ?? parsed;
          shape = { keys: Object.keys(parsed), count: rows?.length, first: rows?.[0], last: rows?.at?.(-1) };
        } catch { shape = { contentPrefix: content?.slice(0, 160) }; }
        console.log(JSON.stringify({ finishReason: choice?.finish_reason, ...shape }));
        return response;
      } } } };
    };
  }
  const generate = load('lib/strokegen.ts').generateStroke;
  const author = original.agents.find(agent => agent.id === 'agent-000');
  if (!author) throw new Error('Example author not found.');
  const stroke = await generate(author, 'wu', 'you', Date.now(), undefined, { mode: 'example', requireModel: true });
  if (stroke.from !== 'wu' || stroke.to !== 'you' || stroke.generation_mode !== 'example') throw new Error('Invalid example.');
  const snapshot = { ...existing, version: 3, capturedAt: new Date().toISOString(), strokes: [stroke], canvasRevision: existing.canvasRevision + 1, skyBatch: null };
  fs.writeFileSync(destination, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(JSON.stringify({ example: stroke.id, from: stroke.from, to: stroke.to, steps: stroke.points.length, length: stroke.visual_signature.length, author: author.name, model: stroke.model, archivedStrokes: original.strokes.length }));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });

// Explicit, additive maintenance import. Never called by a page, build or cron.
// Usage: node --env-file=.env.local scripts/import-artwork-archive.cjs snapshot.json [...]
const fs = require('node:fs');
const path = require('node:path');
const { createTypeScriptLoader } = require('../tests/load-typescript.cjs');

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Provide one or more artwork snapshot JSON files.');
  // Validate every file before beginning; imports are idempotent and never overwrite.
  const snapshots = files.map(file => {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.strokes) || !Array.isArray(data.agents)) throw new Error(`Invalid snapshot: ${path.basename(file)}`);
    for (const stroke of data.strokes) {
      if (!stroke || typeof stroke.id !== 'string' || !stroke.id.startsWith('stroke-') || !Number.isFinite(stroke.created_at) || !Array.isArray(stroke.points)) {
        throw new Error(`Invalid artwork in ${path.basename(file)}`);
      }
    }
    return {file, data, raw};
  });
  const load = createTypeScriptLoader();
  const { importArchivedStrokes, importArchivedSnapshot } = load('lib/store.ts');
  const { closeDatabases, databaseTransaction } = load('lib/database.ts');
  try {
    let inserted = 0;
    for (const {file, data, raw} of snapshots) {
      await importArchivedSnapshot(raw, {source:`legacy-import:${path.basename(file)}`});
      const count = await importArchivedStrokes(data.strokes, {source:`legacy-import:${path.basename(file)}`, agents:data.agents});
      inserted += count;
      console.log(JSON.stringify({snapshot:path.basename(file),artworks:data.strokes.length,inserted:count}));
    }
    // Verify all artwork IDs are present. Do not print payloads or connection info.
    const ids = [...new Set(snapshots.flatMap(s => s.data.strokes.map(s => s.id)))];
    await databaseTransaction(async db => {
      for (const id of ids) {
        const result = await db.query('SELECT id FROM noema_artworks WHERE id=$1',[id]);
        if (!result.rows.length) throw new Error('Archive verification failed.');
      }
    });
    console.log(JSON.stringify({verified:ids.length,inserted,mode:'additive; no canvas reset; no artwork deletion'}));
  } finally { await closeDatabases(); }
}
main().catch(error => {
  // Database errors can include credentials; only report a bounded error code.
  console.error('Archive import failed.', /^[A-Z0-9_]{2,40}$/.test(error.code || '') ? error.code : 'Check snapshot format and database configuration.');
  process.exitCode = 1;
});

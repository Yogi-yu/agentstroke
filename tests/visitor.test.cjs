const test = require('node:test');
const assert = require('node:assert/strict');
const { createTypeScriptLoader } = require('./load-typescript.cjs');
const load = createTypeScriptLoader();
const { visitorId, visitorToken, newVisitorToken, withVisitor } = load('lib/visitor.ts');
const request = (token, method = 'GET', more = {}) => new Request('https://noema.test/api/strokes', { method, headers: { cookie: `noema_visitor=${token}`, ...more } });

test('opaque visitor identities are stable, high entropy and not client owner headers', () => {
  const a = newVisitorToken(), b = newVisitorToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.notEqual(visitorId(request(a)), a);
  assert.equal(visitorId(request(a)), visitorId(request(a, 'GET', { 'x-owner-id': visitorId(request(b)) })));
  assert.notEqual(visitorId(request(a)), visitorId(request(b)));
});

test('missing, invalid and duplicate tokens cannot silently share a global canvas', async () => {
  for (const cookie of ['', 'noema_visitor=public', 'noema_visitor=../../etc', `noema_visitor=${'a'.repeat(64)}; noema_visitor=${'b'.repeat(64)}`]) {
    const req = new Request('https://noema.test/api/strokes', { headers: { cookie } });
    assert.equal(visitorToken(req), null);
    const response = await withVisitor(req, async () => { throw new Error('must not call database'); });
    assert.equal(response.status, 409);
  }
});

test('all visitor-scoped mutations reject cross-site origin before database access', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const response = await withVisitor(request(newVisitorToken(), method, { origin: 'https://evil.test' }), async () => { throw new Error('must not access store'); });
    assert.equal(response.status, 403);
  }
});

test('database failure is a safe503, never false save success or a credential leak', async () => {
  const response = await withVisitor(request(newVisitorToken(), 'POST'), async () => { throw new Error('postgres://secret-password@host/db'); });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('secret-password'), false);
});

test('successful visitor data cannot enter shared HTTP cache', async () => {
  const response = await withVisitor(request(newVisitorToken()), async () => Response.json({ ok: true }));
  assert.match(response.headers.get('cache-control'), /private, no-store/);
});

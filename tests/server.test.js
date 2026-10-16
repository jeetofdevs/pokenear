'use strict';
// End-to-end test of the X login flow and game API against a mock X API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const USERS = {
  'code-alice': { id: '101', username: 'alice_tcg', name: 'Alice' },
  'code-bob': { id: '202', username: 'bob_pulls', name: 'Bob' }
};

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test('X login, referral and game API', async () => {
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/2/oauth2/token') {
        const p = new URLSearchParams(body);
        assert.ok(p.get('code_verifier'), 'PKCE verifier sent');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: p.get('code') }));
      }
      if (req.url.startsWith('/2/users/me')) {
        const u = USERS[(req.headers.authorization || '').replace('Bearer ', '')];
        res.writeHead(u ? 200 : 401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(u ? { data: u } : {}));
      }
      res.writeHead(404); res.end();
    });
  });
  const mockPort = await listen(mock);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokenear-'));
  Object.assign(process.env, {
    X_CLIENT_ID: 'test-client',
    X_REDIRECT_URI: 'http://localhost/auth/x/callback',
    X_API_BASE: `http://127.0.0.1:${mockPort}`,
    DB_FILE: path.join(dir, 'db.json')
  });
  const { server } = require('../server/server.js');
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  async function login(code, ref) {
    const r1 = await fetch(`${base}/auth/x/login${ref ? '?ref=' + ref : ''}`, { redirect: 'manual' });
    assert.equal(r1.status, 302);
    const loc = new URL(r1.headers.get('location'));
    assert.equal(loc.searchParams.get('client_id'), 'test-client');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    const state = loc.searchParams.get('state');
    const r2 = await fetch(`${base}/auth/x/callback?state=${state}&code=${code}`, { redirect: 'manual' });
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.get('location'), '/#packs');
    return r2.headers.get('set-cookie').split(';')[0];
  }
  const api = (cookie, p, body) => fetch(base + p, body
    ? { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));

  try {
    assert.equal((await api('', '/api/config')).body.mode, 'live');
    assert.equal((await api('', '/api/action', { type: 'daily' })).status, 401);

    const alice = await login('code-alice');
    const me = (await api(alice, '/api/me')).body.state;
    assert.equal(me.user.handle, 'alice_tcg');
    assert.equal(me.balance, 1000);

    const pull = await api(alice, '/api/action', { type: 'pull', series: 'pocket', count: 10 });
    assert.equal(pull.status, 200);
    assert.equal(pull.body.result.cards.length, 10);
    assert.equal(pull.body.state.balance, 100);

    // Clients cannot fake invites.
    assert.equal((await api(alice, '/api/action', { type: 'inviteJoined' })).status, 400);
    const broke = await api(alice, '/api/action', { type: 'pull', series: 'pocket', count: 10 });
    assert.equal(broke.status, 400);
    assert.match(broke.body.error, /Not enough/);

    const bob = await login('code-bob', me.user.refCode);
    const bobState = (await api(bob, '/api/me')).body.state;
    assert.equal(bobState.balance, 1200);
    const aliceAfter = (await api(alice, '/api/me')).body.state;
    assert.equal(aliceAfter.invites, 1);
    assert.equal(aliceAfter.balance, 100 + 250);

    // Logging in again does not reset progress or double-count the referral.
    await login('code-bob', me.user.refCode);
    assert.equal((await api(alice, '/api/me')).body.state.invites, 1);

    const lb = (await api(bob, '/api/leaderboard')).body.rows;
    assert.equal(lb[0].handle, 'alice_tcg');

    const bad = await fetch(`${base}/auth/x/callback?state=nope&code=code-alice`, { redirect: 'manual' });
    assert.equal(bad.headers.get('location'), '/?x_error=1');

    assert.equal((await fetch(`${base}/server/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    server.close();
    mock.close();
  }
});

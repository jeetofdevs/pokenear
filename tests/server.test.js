'use strict';
// End-to-end test of wallet sign-in (Solana + NEAR NEP-413) and the game API, with a mock NEAR RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../js/auth.js');

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, privateKey };
}
// What Phantom / Solflare return from signMessage, sent as base64.
function solanaSign(kp, message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), kp.privateKey).toString('base64');
}
// NEP-413, built independently of the server code.
function nearSign(kp, { message, nonce, recipient }) {
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2147484061);
  const payload = Buffer.concat([tag, str(message), nonce, str(recipient), Buffer.from([0])]);
  const hash = crypto.createHash('sha256').update(payload).digest();
  return crypto.sign(null, hash, kp.privateKey).toString('base64');
}

test('wallet sign-in, referral and game API', async () => {
  const nearKeys = {}; // account -> "ed25519:..." full-access key
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { params } = JSON.parse(body);
      const ok = nearKeys[params.account_id] === params.public_key;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { result: { permission: 'FullAccess', nonce: 1 } } : { error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } }));
    });
  });
  const rpcPort = await listen(rpc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokenear-'));
  Object.assign(process.env, { NEAR_RPC: `http://127.0.0.1:${rpcPort}`, DB_FILE: path.join(dir, 'db.json') });
  const { server } = require('../server/server.js');
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const post = (p, body, cookie = '') => fetch(base + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }));
  const get = (p, cookie = '') => fetch(base + p, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const nonce = async () => (await post('/api/auth/nonce', {})).body.nonce;

  async function solanaLogin(kp, ref) {
    const address = auth.base58Encode(kp.raw);
    const n = await nonce();
    return post('/api/auth/wallet', { chain: 'solana', address, nonce: n, signature: solanaSign(kp, auth.loginMessage('solana', address, n)), ref, wallet: 'Phantom' });
  }
  async function nearLogin(kp, accountId, ref) {
    const n = await nonce();
    const signature = nearSign(kp, { message: auth.loginMessage('near', null, n), nonce: Buffer.from(n, 'hex'), recipient: auth.NEAR_RECIPIENT });
    return post('/api/auth/wallet', { chain: 'near', accountId, publicKey: 'ed25519:' + auth.base58Encode(kp.raw), nonce: n, signature, ref, wallet: 'Meteor Wallet' });
  }

  try {
    assert.equal((await get('/api/config')).body.mode, 'live');
    assert.equal((await post('/api/action', { type: 'daily' })).status, 401);

    // Solana
    const sol = keypair();
    const a = await solanaLogin(sol);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.state.user.chain, 'solana');
    assert.equal(a.body.state.user.address, auth.base58Encode(sol.raw));
    assert.equal(a.body.state.balance, 2000);
    const alice = a.cookie;

    // Wrong signer, reused nonce, unknown nonce
    const imposter = keypair();
    const n1 = await nonce();
    const victim = auth.base58Encode(sol.raw);
    const bad = await post('/api/auth/wallet', { chain: 'solana', address: victim, nonce: n1, signature: solanaSign(imposter, auth.loginMessage('solana', victim, n1)) });
    assert.equal(bad.status, 401);
    const reuse = await post('/api/auth/wallet', { chain: 'solana', address: victim, nonce: n1, signature: solanaSign(sol, auth.loginMessage('solana', victim, n1)) });
    assert.equal(reuse.status, 400);
    assert.match(reuse.body.error, /expired/);

    // Game API with the session
    const rip = await post('/api/action', { type: 'pull', pack: 'starter', count: 1 }, alice);
    assert.equal(rip.status, 200);
    assert.equal(rip.body.state.balance, 1000);
    const sold = await post('/api/action', { type: 'buyback', uid: rip.body.result.items[0].uid }, alice);
    assert.equal(sold.status, 200);
    assert.equal((await post('/api/action', { type: 'inviteJoined' }, alice)).status, 400);
    const broke = await post('/api/action', { type: 'pull', pack: 'legend', count: 5 }, alice);
    assert.match(broke.body.error, /Not enough/);
    const aliceBalance = (await get('/api/me', alice)).body.state.balance;

    // NEAR named account, referred by the Solana user
    const nk = keypair();
    nearKeys['bob.near'] = 'ed25519:' + auth.base58Encode(nk.raw);
    const b = await nearLogin(nk, 'bob.near', a.body.state.user.refCode);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.state.user.address, 'bob.near');
    assert.equal(b.body.state.balance, 2500);
    const aliceAfter = (await get('/api/me', alice)).body.state;
    assert.equal(aliceAfter.invites, 1);
    assert.equal(aliceAfter.balance, aliceBalance + 500);

    // Signing again does not reset progress or double-count the referral.
    await nearLogin(nk, 'bob.near', a.body.state.user.refCode);
    assert.equal((await get('/api/me', alice)).body.state.invites, 1);

    // NEAR: valid signature but the key is not on the account
    const stranger = keypair();
    const c = await nearLogin(stranger, 'bob.near');
    assert.equal(c.status, 401);
    assert.match(c.body.error, /full-access key/);

    // NEAR implicit account: the account id is the key in hex, no RPC needed
    const ik = keypair();
    const implicit = Buffer.from(ik.raw).toString('hex');
    assert.equal((await nearLogin(ik, implicit)).status, 200);
    assert.equal((await nearLogin(keypair(), implicit)).status, 401);

    const lb = (await get('/api/leaderboard')).body.rows;
    assert.ok(lb.some((r) => r.address === 'bob.near'));

    assert.equal((await post('/api/auth/logout', {}, alice)).status, 200);
    assert.equal((await get('/api/me', alice)).body.state, null);

    assert.equal((await fetch(`${base}/server/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/vendor/near-wallet.js`)).status, 200);
    for (const f of ['js/auth.js', 'js/wallets.js', 'js/cards.js', 'js/data.js', 'js/engine.js', 'js/store.js', 'js/app.js', 'css/style.css']) assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    server.close();
    rpc.close();
  }
});

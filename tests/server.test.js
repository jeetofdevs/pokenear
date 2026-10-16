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
  const nearDraws = {}; // seed -> { account, randomness }
  const solAccounts = {}; // address -> { owner, data }
  // One mock answers both NEAR RPC (view_access_key, call_function get_draw) and Solana RPC (getAccountInfo).
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (method === 'getAccountInfo') {
        const acc = solAccounts[params[0]];
        return res.end(JSON.stringify({ result: { value: acc ? { owner: acc.owner, data: [acc.data.toString('base64'), 'base64'] } : null } }));
      }
      if (params.request_type === 'call_function') {
        assert.equal(params.account_id, 'rng.pokenear.near');
        const { seed } = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const d = nearDraws[seed] || null;
        return res.end(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(d))] } }));
      }
      const ok = nearKeys[params.account_id] === params.public_key;
      res.end(JSON.stringify(ok ? { result: { permission: 'FullAccess', nonce: 1 } } : { error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } }));
    });
  });
  const onchain = require('../server/onchain.js');
  // Simulate ORAO: write a RandomnessV2 account for a seed (pending or fulfilled).
  function oraoAccount(seedHex, randomnessHex) {
    const head = Buffer.concat([onchain.DISC_V2, Buffer.from([randomnessHex ? 1 : 0]), crypto.randomBytes(32), Buffer.from(seedHex, 'hex')]);
    const data = randomnessHex ? Buffer.concat([head, Buffer.from(randomnessHex, 'hex')]) : Buffer.concat([head, Buffer.alloc(4)]);
    solAccounts[onchain.oraoRandomnessAddress(seedHex)] = { owner: onchain.ORAO_PROGRAM, data };
  }
  const rpcPort = await listen(rpc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokenear-'));
  Object.assign(process.env, { NEAR_RPC: `http://127.0.0.1:${rpcPort}`, SOLANA_RPC: `http://127.0.0.1:${rpcPort}`, NEAR_RNG_CONTRACT: 'rng.pokenear.near', DB_FILE: path.join(dir, 'db.json') });
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

    // Ledger through Phantom signs the off-chain message format; it must also be accepted.
    const led = keypair();
    const ledAddr = auth.base58Encode(led.raw);
    const ln = await nonce();
    const lmsg = auth.loginMessage('solana', ledAddr, ln);
    const lsig = crypto.sign(null, require('../server/wallet-verify.js').offchainMessage(lmsg, 0), led.privateKey).toString('base64');
    assert.equal((await post('/api/auth/wallet', { chain: 'solana', address: ledAddr, nonce: ln, signature: lsig, message: lmsg })).status, 200);
    // A message that is not our sign-in text is rejected even with a valid signature.
    const tn = await nonce();
    const tmsg = 'Send me your tokens ' + tn;
    const tamper = await post('/api/auth/wallet', { chain: 'solana', address: ledAddr, nonce: tn, signature: crypto.sign(null, Buffer.from(tmsg), led.privateKey).toString('base64'), message: tmsg });
    assert.equal(tamper.status, 400);

    // Wrong signer, reused nonce, unknown nonce
    const imposter = keypair();
    const n1 = await nonce();
    const victim = auth.base58Encode(sol.raw);
    const bad = await post('/api/auth/wallet', { chain: 'solana', address: victim, nonce: n1, signature: solanaSign(imposter, auth.loginMessage('solana', victim, n1)) });
    assert.equal(bad.status, 401);
    const reuse = await post('/api/auth/wallet', { chain: 'solana', address: victim, nonce: n1, signature: solanaSign(sol, auth.loginMessage('solana', victim, n1)) });
    assert.equal(reuse.status, 400);
    assert.match(reuse.body.error, /expired/);

    // On-chain rip (Solana, ORAO VRF): start -> missing -> pending -> fulfilled
    assert.equal((await post('/api/action', { type: 'pull', pack: 'starter', count: 1 }, alice)).status, 400);
    const start = await post('/api/rip/start', { pack: 'starter', count: 1 }, alice);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.state.balance, 1000);
    assert.equal(start.body.rng.solana.program, onchain.ORAO_PROGRAM);
    const seed = start.body.rip.seed;
    assert.match(seed, /^[0-9a-f]{64}$/);
    assert.equal((await post('/api/rip/start', { pack: 'starter', count: 1 }, alice)).status, 400); // one open rip at a time
    assert.equal((await post('/api/rip/finish', {}, alice)).status, 202); // nothing on chain yet
    oraoAccount(seed, null);
    const pend = await post('/api/rip/finish', {}, alice);
    assert.equal(pend.status, 202);
    assert.equal(pend.body.status, 'pending');
    assert.equal((await post('/api/rip/cancel', {}, alice)).status, 409); // randomness requested: no refund
    const randomness = crypto.randomBytes(64).toString('hex');
    oraoAccount(seed, randomness);
    const fin = await post('/api/rip/finish', { tx: 'solanaTxSig' }, alice);
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    const item = fin.body.result.items[0];
    assert.equal(item.id, require('../js/engine.js').cardsFromRandomness('starter', 1, randomness, seed)[0].id);
    assert.equal(item.proof.randomness, randomness);
    assert.equal(item.proof.source, 'orao-vrf');
    assert.equal(item.proof.ref, onchain.oraoRandomnessAddress(seed));
    assert.equal(fin.body.state.pendingRip, null);

    // Cancel before any on-chain request refunds.
    const s2 = await post('/api/rip/start', { pack: 'starter', count: 1 }, alice);
    assert.equal(s2.body.state.balance, 0);
    const cancel = await post('/api/rip/cancel', {}, alice);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state.balance, 1000);

    const sold = await post('/api/action', { type: 'buyback', uid: item.uid }, alice);
    assert.equal(sold.status, 200);
    assert.equal((await post('/api/action', { type: 'inviteJoined' }, alice)).status, 400);
    const broke = await post('/api/rip/start', { pack: 'legend', count: 5 }, alice);
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

    // On-chain rip (NEAR contract): draw must come from the player's own account.
    const bob = b.cookie;
    const ns = await post('/api/rip/start', { pack: 'starter', count: 1 }, bob);
    assert.equal(ns.status, 200);
    assert.equal(ns.body.rng.near.contract, 'rng.pokenear.near');
    nearDraws[ns.body.rip.seed] = { account: 'mallory.near', randomness: 'aa'.repeat(32), block_height: 1 };
    assert.equal((await post('/api/rip/finish', {}, bob)).status, 400);
    nearDraws[ns.body.rip.seed] = { account: 'bob.near', randomness: 'bb'.repeat(32), block_height: 7 };
    const nf = await post('/api/rip/finish', {}, bob);
    assert.equal(nf.status, 200, JSON.stringify(nf.body));
    assert.equal(nf.body.result.items[0].proof.source, 'near-rng');
    assert.equal(nf.body.result.items[0].id, require('../js/engine.js').cardsFromRandomness('starter', 1, 'bb'.repeat(32), ns.body.rip.seed)[0].id);

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
    assert.equal((await fetch(`${base}/assets/brand/pokenear-icon.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/assets/brand/x-header.html`)).status, 404);
  } finally {
    server.close();
    rpc.close();
  }
});

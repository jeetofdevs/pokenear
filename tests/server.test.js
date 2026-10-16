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
function nearSign(kp, { message, nonce, recipient, callbackUrl }) {
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2147484061);
  const payload = Buffer.concat([tag, str(message), nonce, str(recipient), callbackUrl ? Buffer.concat([Buffer.from([1]), str(callbackUrl)]) : Buffer.from([0])]);
  const hash = crypto.createHash('sha256').update(payload).digest();
  return crypto.sign(null, hash, kp.privateKey).toString('base64');
}

test('NEAR sign-in, $POKENEAR rips, dev wallet and buyback payouts', async () => {
  const GAME = 'pokenearfun.near';
  const TOKEN = 'pokenear.tkn.near';
  const UNIT = 10n ** 18n;
  const nearKeys = {}; // account -> "ed25519:..." full-access key
  const draws = {}; // seed -> draw as returned by get_draw
  const paid = new Set(); // payout ref_ids
  const sent = []; // decoded payout calls
  let contract = null; // get_config result; null = not deployed
  const payout = keypair();
  const payoutPub = 'ed25519:' + auth.base58Encode(payout.raw);
  const payoutKey = 'ed25519:' + auth.base58Encode(Buffer.concat([payout.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), payout.raw]));
  const blockHash = auth.base58Encode(crypto.randomBytes(32));
  // One mock NEAR RPC: access keys, views on the game contract and the token, broadcast_tx_commit.
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      const reply = (x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
      const view = (v) => reply({ result: { result: [...Buffer.from(JSON.stringify(v))] } });
      if (method === 'broadcast_tx_commit') {
        const tx = Buffer.from(params[0], 'base64');
        const bodyBytes = tx.subarray(0, tx.length - 65);
        const ok = crypto.verify(null, crypto.createHash('sha256').update(bodyBytes).digest(), crypto.createPublicKey(payout.privateKey), tx.subarray(-64));
        const json = /\{"receiver_id".*\}/.exec(bodyBytes.toString('latin1'));
        const args = json && JSON.parse(json[0]);
        sent.push({ ok, args, method: bodyBytes.includes(Buffer.from('payout')) });
        if (!ok) return reply({ error: { name: 'INVALID_TRANSACTION' } });
        const first = !paid.has(args.ref_id);
        paid.add(args.ref_id);
        return reply({ result: { status: { SuccessValue: Buffer.from(JSON.stringify(first)).toString('base64') } } });
      }
      if (params.request_type === 'view_access_key') {
        if (params.account_id === GAME && params.public_key === payoutPub) return reply({ result: { permission: { FunctionCall: {} }, nonce: 41, block_hash: blockHash } });
        const ok = nearKeys[params.account_id] === params.public_key;
        return reply(ok ? { result: { permission: 'FullAccess', nonce: 1, block_hash: blockHash } } : { error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } });
      }
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString() || '{}');
      if (params.account_id === GAME) {
        if (!contract) return reply({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } });
        if (params.method_name === 'get_config') return view(contract);
        if (params.method_name === 'get_draw') return view(draws[args.seed] || null);
        if (params.method_name === 'is_paid') return view(paid.has(args.ref_id));
      }
      if (params.account_id === TOKEN) {
        if (params.method_name === 'ft_metadata') return view({ symbol: 'POKENEAR', decimals: 18 });
        if (params.method_name === 'ft_balance_of') return view(String(123n * UNIT + 45n * UNIT / 100n));
      }
      reply({ error: { cause: { name: 'UNKNOWN' } } });
    });
  });
  const rpcPort = await listen(rpc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokenear-'));
  Object.assign(process.env, { NEAR_RPC: `http://127.0.0.1:${rpcPort}`, PAYOUT_KEY: payoutKey, DB_FILE: path.join(dir, 'db.json') });
  const srv = require('../server/server.js');
  const { server } = srv;
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const engine = require('../js/engine.js');

  const post = (p, body, cookie = '') => fetch(base + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }));
  const get = (p, cookie = '') => fetch(base + p, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const nonce = async () => (await post('/api/auth/nonce', {})).body.nonce;

  // opts.sent: callbackUrl the client sends; opts.signed: callbackUrl the wallet put in the payload.
  async function nearLogin(kp, accountId, opts = {}) {
    const n = await nonce();
    const signature = nearSign(kp, { message: auth.loginMessage('near', null, n), nonce: Buffer.from(n, 'hex'), recipient: auth.NEAR_RECIPIENT, callbackUrl: opts.signed });
    const publicKey = (opts.bareKey ? '' : 'ed25519:') + auth.base58Encode(kp.raw);
    return post('/api/auth/wallet', { chain: 'near', accountId, publicKey, nonce: n, signature, wallet: opts.wallet || 'Meteor Wallet', callbackUrl: opts.sent });
  }
  const register = (account) => { const k = keypair(); nearKeys[account] = 'ed25519:' + auth.base58Encode(k.raw); return k; };

  try {
    const cfg0 = (await get('/api/config')).body;
    assert.equal(cfg0.mode, 'live');
    assert.deepEqual(cfg0.chains, ['near']);
    assert.equal(cfg0.game.ready, false);
    assert.deepEqual(cfg0.devAccounts, [GAME]);

    // Solana sign-in is closed: $POKENEAR lives on NEAR.
    const sol = keypair();
    const solAddr = auth.base58Encode(sol.raw);
    const sn = await nonce();
    const solTry = await post('/api/auth/wallet', { chain: 'solana', address: solAddr, nonce: sn, signature: solanaSign(sol, auth.loginMessage('solana', solAddr, sn)) });
    assert.equal(solTry.status, 400);
    assert.match(solTry.body.error, /NEAR wallet/);

    const nk = register('bob.near');
    const b = await nearLogin(nk, 'bob.near');
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.state.user.address, 'bob.near');
    assert.equal(b.body.state.balance, undefined); // no credits
    const bob = b.cookie;
    for (const type of ['daily', 'inviteJoined']) assert.equal((await fetch(base + '/api/action', { method: 'POST', headers: { cookie: bob }, body: JSON.stringify({ type }) })).status, 405);

    // Contract not deployed / token not set: rips are closed for players.
    const closed = await post('/api/rip/start', { pack: 'starter', count: 1 }, bob);
    assert.equal(closed.status, 503);
    assert.match(closed.body.error, /\$POKENEAR is live/);

    // Launch: the owner sets the CA and prices on pokenearfun.near.
    contract = { owner: GAME, token: TOKEN, prices: ['1000', '2500', '5000', '10000'].map((x) => String(BigInt(x) * UNIT)), max_per_rip: 5 };
    srv.resetGameCache();
    const cfg = (await get('/api/config')).body.game;
    assert.equal(cfg.ready, true);
    assert.equal(cfg.token, TOKEN);
    assert.equal(cfg.decimals, 18);
    assert.equal(cfg.buyback, true);
    const bal = await get('/api/balance', bob);
    assert.equal(bal.body.amount, String(123n * UNIT + 45n * UNIT / 100n));

    // Paid rip: start -> pay instructions -> nothing on chain (202) -> draw -> cards.
    const start = await post('/api/rip/start', { pack: 'rare', count: 5 }, bob);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const seed = start.body.rip.seed;
    assert.deepEqual(start.body.pay, { token: TOKEN, receiver: GAME, amount: String(5n * 2500n * UNIT), msg: JSON.stringify({ seed, pack: 1, count: 5 }) });
    assert.equal((await post('/api/rip/start', { pack: 'starter', count: 1 }, bob)).status, 400); // one open rip at a time
    const wait = await post('/api/rip/finish', {}, bob);
    assert.equal(wait.status, 202);
    assert.equal(wait.body.pay.msg, start.body.pay.msg);
    // A draw paid by someone else, or for another pack, does not count.
    draws[seed] = { account: 'mallory.near', randomness: 'aa'.repeat(32), block_height: 1, pack: 1, count: 5, amount: start.body.pay.amount };
    assert.equal((await post('/api/rip/finish', {}, bob)).status, 400);
    draws[seed] = { account: 'bob.near', randomness: 'aa'.repeat(32), block_height: 1, pack: 0, count: 5, amount: start.body.pay.amount };
    assert.equal((await post('/api/rip/finish', {}, bob)).status, 400);
    assert.equal((await post('/api/rip/cancel', {}, bob)).status, 409); // paid: cannot cancel
    draws[seed] = { account: 'bob.near', randomness: 'bb'.repeat(32), block_height: 7, pack: 1, count: 5, amount: start.body.pay.amount };
    const fin = await post('/api/rip/finish', { tx: 'H1' }, bob);
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    const items = fin.body.result.items;
    assert.deepEqual(items.map((i) => i.id), engine.cardsFromRandomness('rare', 5, 'bb'.repeat(32), seed).map((c) => c.id));
    assert.deepEqual(items[0].proof, { source: 'pokenear-near', chain: 'near', seed, randomness: 'bb'.repeat(32), ref: GAME, tx: 'H1', paid: start.body.pay.amount });

    // Unpaid rip can be cancelled.
    assert.equal((await post('/api/rip/start', { pack: 'starter', count: 1 }, bob)).status, 200);
    const cancel = await post('/api/rip/cancel', {}, bob);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state.pendingRip, null);

    // Buyback: pokenearfun.near pays BUYBACK_RATE of value at the on-chain Starter rate (1000 tokens = $10).
    const sell = items.slice(0, 2).map((i) => i.uid);
    const usd = Math.round(items.slice(0, 2).reduce((n, i) => n + require('../js/data.js').cardById[i.id].usd, 0) * require("../js/data.js").BUYBACK_RATE * 100) / 100;
    const sold = await post('/api/buyback', { uids: sell }, bob);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    const expected = 1000n * UNIT * BigInt(Math.round(usd * 100)) / 1000n;
    assert.equal(sold.body.result.payout.amount, expected.toString());
    assert.equal(sent.length, 1);
    assert.ok(sent[0].ok && sent[0].method);
    assert.deepEqual(Object.keys(sent[0].args), ['receiver_id', 'amount', 'ref_id']);
    assert.equal(sent[0].args.receiver_id, 'bob.near');
    assert.equal(sent[0].args.amount, expected.toString());
    assert.equal(sold.body.state.vault.length, 3);
    assert.equal((await post('/api/buyback', { uids: sell }, bob)).status, 400); // already sold

    // Dev wallet: rips without paying, recorded like any rip; buyback records without a payout.
    const dk = register(GAME);
    const dev = (await nearLogin(dk, GAME)).cookie;
    const dr = await post('/api/rip/start', { pack: 'legend', count: 5 }, dev);
    assert.equal(dr.status, 200, JSON.stringify(dr.body));
    assert.equal(dr.body.pay, null);
    assert.equal(dr.body.result.items.length, 5);
    assert.equal(dr.body.result.items[0].proof.source, 'dev');
    const devState = (await get('/api/me', dev)).body.state;
    assert.equal(devState.vault.length, 5);
    assert.equal(devState.totalPulls, 5);
    assert.equal(devState.pendingRip, null);
    const devSell = await post('/api/buyback', { uids: [devState.vault[0].uid] }, dev);
    assert.equal(devSell.status, 200);
    assert.equal(devSell.body.result.payout.dev, true);
    assert.equal(sent.length, 1); // no payout transaction for the dev wallet
    // The dev wallet still rips while the contract is unreachable.
    contract = null;
    srv.resetGameCache();
    assert.equal((await post('/api/rip/start', { pack: 'starter', count: 1 }, dev)).status, 200);
    assert.equal((await post('/api/rip/start', { pack: 'starter', count: 1 }, bob)).status, 503);

    // HOT / Meteor sign without callbackUrl even though the page sends one; redirect wallets may sign it.
    const page = 'https://pokenear.fun/#packs';
    assert.equal((await nearLogin(nk, 'bob.near', { sent: page, wallet: 'HOT Wallet' })).status, 200);
    assert.equal((await nearLogin(nk, 'bob.near', { sent: page, signed: page, wallet: 'MyNearWallet' })).status, 200);
    assert.equal((await nearLogin(nk, 'bob.near', { sent: page, bareKey: true })).status, 200);
    const forged = await nearLogin(nk, 'bob.near', { sent: page, signed: 'https://evil.example/' });
    assert.equal(forged.status, 401);
    assert.match(forged.body.error, /NEAR wallet signature did not match/);
    assert.equal((await get('/api/me', bob)).body.state.vault.length, 3); // signing again keeps progress

    // Reused nonce, key not on the account, implicit accounts.
    const n1 = await nonce();
    const sig1 = nearSign(nk, { message: auth.loginMessage('near', null, n1), nonce: Buffer.from(n1, 'hex'), recipient: auth.NEAR_RECIPIENT });
    const pk1 = 'ed25519:' + auth.base58Encode(nk.raw);
    assert.equal((await post('/api/auth/wallet', { chain: 'near', accountId: 'bob.near', publicKey: pk1, nonce: n1, signature: sig1 })).status, 200);
    const reuse = await post('/api/auth/wallet', { chain: 'near', accountId: 'bob.near', publicKey: pk1, nonce: n1, signature: sig1 });
    assert.equal(reuse.status, 400);
    assert.match(reuse.body.error, /expired/);
    const c = await nearLogin(keypair(), 'bob.near');
    assert.equal(c.status, 401);
    assert.match(c.body.error, /full-access key/);
    const ik = keypair();
    const implicit = Buffer.from(ik.raw).toString('hex');
    assert.equal((await nearLogin(ik, implicit)).status, 200);
    assert.equal((await nearLogin(keypair(), implicit)).status, 401);

    const lb = (await get('/api/leaderboard')).body.rows;
    assert.ok(lb.some((r) => r.address === 'bob.near'));
    assert.ok(lb.some((r) => r.address === GAME));

    assert.equal((await post('/api/auth/logout', {}, bob)).status, 200);
    assert.equal((await get('/api/me', bob)).body.state, null);

    assert.equal((await fetch(`${base}/server/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/vendor/near-wallet.js`)).status, 200);
    for (const f of ['js/auth.js', 'js/wallets.js', 'js/cards.js', 'js/data.js', 'js/engine.js', 'js/store.js', 'js/app.js', 'js/sha256.js', 'css/style.css']) assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/assets/brand/pokenear-icon.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/assets/brand/x-header.html`)).status, 404);
  } finally {
    server.close();
    rpc.close();
  }
});

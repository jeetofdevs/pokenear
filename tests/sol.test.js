'use strict';
// End-to-end test of the Solana (SOL) pack flow with a mock Solana RPC and price feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../js/auth.js');

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = auth.base58Encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, sign: (text) => crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') };
}
const sig = () => auth.base58Encode(crypto.randomBytes(64));
const hash = () => auth.base58Encode(crypto.randomBytes(32));

test('SOL packs: sign in with a Solana wallet, pay the treasury in SOL, get cards with proof', async () => {
  const owner = wallet();
  const bob = wallet();
  const txs = {}; // signature -> getTransaction result
  const blocks = {}; // slot -> { blockhash, blockTime }
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (req.url === '/price') return reply({ usd: 150 });
      const { method, params } = JSON.parse(body);
      if (method === 'getTransaction') return reply({ jsonrpc: '2.0', id: 1, result: txs[params[0]] || null });
      if (method === 'getBlock') return reply({ jsonrpc: '2.0', id: 1, result: blocks[params[0]] || null });
      if (method === 'getLatestBlockhash') return reply({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 99 } } });
      if (method === 'getBalance') return reply({ jsonrpc: '2.0', id: 1, result: { value: 2500000000 } });
      reply({ jsonrpc: '2.0', id: 1, error: { message: 'unknown method ' + method } });
    });
  });
  const rpcPort = await listen(rpc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonkpacks-'));
  Object.assign(process.env, { CHAIN: 'solana', SOLANA_RPC: `http://127.0.0.1:${rpcPort}`, PRICE_URL: `http://127.0.0.1:${rpcPort}/price`, TREASURY_SOL: owner.address, DB_FILE: path.join(dir, 'db.json') });
  const srv = require('../server/server.js');
  const port = await listen(srv.server);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, b, cookie = '') => fetch(base + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }));
  const get = (p, cookie = '') => fetch(base + p, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  async function login(w) {
    const nonce = (await post('/api/auth/nonce')).body.nonce;
    const message = auth.loginMessage('solana', w.address, nonce);
    const r = await post('/api/auth/wallet', { chain: 'solana', address: w.address, nonce, signature: w.sign(message), message, wallet: 'Phantom' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.cookie;
  }
  // A confirmed SOL payment as getTransaction(jsonParsed) returns it.
  function paid({ from, to, lamports, slot = 500, err = null, blockTime = Math.floor(Date.now() / 1000) }) {
    const s = sig();
    txs[s] = {
      slot, blockTime, meta: { err },
      transaction: { message: {
        accountKeys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }],
        instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: from, destination: to, lamports: Number(lamports) } } }]
      } }
    };
    if (!blocks[slot]) blocks[slot] = { blockhash: hash(), blockTime };
    return s;
  }

  try {
    const cfg = (await get('/api/config')).body;
    assert.equal(cfg.chain, 'solana');
    assert.deepEqual(cfg.chains, ['solana']);
    assert.equal(cfg.game.currency, 'SOL');
    assert.equal(cfg.game.ready, true, JSON.stringify(cfg.game));
    assert.equal(cfg.game.treasury, owner.address);
    // $10 at $150/SOL = 0.0666… SOL, rounded up to 0.0001 SOL.
    assert.equal(cfg.game.prices[0], '66700000');
    assert.deepEqual(cfg.devAccounts, [owner.address]);

    // NEAR sign-in is closed on the Solana site.
    assert.equal((await post('/api/auth/wallet', { chain: 'near', accountId: 'bob.near', nonce: (await post('/api/auth/nonce')).body.nonce })).status, 400);

    const b = await login(bob);
    assert.equal((await get('/api/balance', b)).body.amount, '2500000000');
    assert.equal((await get('/api/sol/blockhash', b)).body.lastValidBlockHeight, 99);

    const start = await post('/api/rip/start', { pack: 'starter', count: 1 }, b);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.deepEqual(start.body.pay, { method: 'sol-transfer', chain: 'solana', receiver: owner.address, lamports: '66700000', deposit: '66700000' });
    assert.equal((await post('/api/rip/finish', {}, b)).status, 202);

    // Wrong amount, wrong receiver, failed tx, not a signature: refused, the pack stays open.
    assert.match((await post('/api/rip/finish', { tx: paid({ from: bob.address, to: owner.address, lamports: '1000' }) }, b)).body.error, /not the payment/);
    assert.match((await post('/api/rip/finish', { tx: paid({ from: bob.address, to: bob.address, lamports: '66700000' }) }, b)).body.error, /not the payment/);
    assert.match((await post('/api/rip/finish', { tx: paid({ from: bob.address, to: owner.address, lamports: '66700000', err: { InstructionError: [0, 'x'] } }) }, b)).body.error, /failed/);
    assert.equal((await post('/api/rip/finish', { tx: 'abc' }, b)).status, 400);
    // Sent before the pack was started.
    assert.match((await post('/api/rip/finish', { tx: paid({ from: bob.address, to: owner.address, lamports: '66700000', slot: 7, blockTime: Math.floor(Date.now() / 1000) - 3600 }) }, b)).body.error, /before/);
    // Not landed yet.
    const later = sig();
    assert.equal((await post('/api/rip/finish', { tx: later }, b)).status, 202);

    const good = paid({ from: bob.address, to: owner.address, lamports: '66700000', slot: 900 });
    const done = await post('/api/rip/finish', { tx: good }, b);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const item = done.body.state.vault[0];
    const seed = item.proof.seed;
    const expect = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('stonkpacks-sol:v1'), Buffer.from(auth.base58Decode(blocks[900].blockhash)), Buffer.from(seed, 'hex')])).digest('hex');
    assert.deepEqual({ source: item.proof.source, chain: item.proof.chain, randomness: item.proof.randomness, tx: item.proof.tx, ref: item.proof.ref, paid: item.proof.paid, block: item.proof.block },
      { source: 'sol-transfer', chain: 'solana', randomness: expect, tx: good, ref: owner.address, paid: '66700000', block: blocks[900].blockhash });
    // The same payment cannot open a second pack.
    await post('/api/rip/start', { pack: 'starter', count: 1 }, b);
    assert.match((await post('/api/rip/finish', { tx: good }, b)).body.error, /already used/);
    assert.equal((await post('/api/rip/cancel', {}, b)).status, 200);

    // Owner (treasury wallet): free openings, admin page.
    const o = await login(owner);
    const free = await post('/api/rip/start', { pack: 'legend', count: 5 }, o);
    assert.equal(free.status, 200);
    assert.equal(free.body.pay, null);
    assert.equal(free.body.state.vault.length, 5);
    assert.equal(free.body.state.vault[0].proof.source, 'dev');
    assert.equal((await get('/api/admin/status', b)).status, 403);
    const adm = await get('/api/admin/status', o);
    assert.equal(adm.status, 200);
    assert.equal(adm.body.treasury, owner.address);
    assert.equal(adm.body.treasuryLamports, '2500000000');
    assert.equal((await post('/api/admin/price', { usd: '149.5' }, o)).body.usd, '149.5');
    // Buyback is not live on Solana yet.
    assert.equal((await post('/api/buyback', { uids: [item.uid] }, b)).status, 503);
  } finally {
    srv.server.close();
    rpc.close();
  }
});

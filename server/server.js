'use strict';
/* Near Packs server: static files + NEAR wallet sign-in + authoritative game API.
   No runtime dependencies. Sign-in is a signed message with a one-time nonce.
   Rips are paid in NEAR: the player calls rip() on the interaction wallet's contract (GAME_ACCOUNT,
   nearpacks.near) with the pack price attached; it draws the randomness and forwards the NEAR to
   the treasury (nearpacks.near) in the same transaction. The server reads the draw back.
   Buybacks are paid in NEAR by that contract, called with a function-call key (PAYOUT_KEY).
   Game state lives in a JSON file (DB_FILE). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require('../js/engine.js');
const D = require('../js/data.js');
const auth = require('../js/auth.js');
const verify = require('./wallet-verify.js');
const onchain = require('./onchain.js');
const nearTx = require('./near-tx.js');
const price = require('./price.js');

loadDotEnv(path.join(__dirname, '..', '.env'));

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
const NEAR_NETWORK = process.env.NEAR_NETWORK || 'mainnet';
// NEAR_RPC may list several URLs (comma separated); each call falls back to the next on failure.
// rpc.*.near.org is deprecated and heavily rate limited, so FastNEAR's free RPC goes first.
const NEAR_RPCS = (process.env.NEAR_RPC || (NEAR_NETWORK === 'testnet'
  ? 'https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org'
  : 'https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org')).split(',').map((u) => u.trim()).filter(Boolean);

async function withNearRpc(fn) {
  let last;
  for (const url of NEAR_RPCS) {
    try { return await fn(url); } catch (err) { last = err; console.warn('[near-rpc]', url, err.message); }
  }
  throw last;
}
// Interaction wallet running contracts/near-rng. Pack prices (yoctoNEAR) and the treasury are read
// from it (set_prices / set_treasury), so launching needs no server change.
const GAME_ACCOUNT = process.env.GAME_ACCOUNT || D.GAME_ACCOUNT;
// Function-call access key of GAME_ACCOUNT allowed to call payout() only. Empty = buyback closed.
const PAYOUT_KEY = process.env.PAYOUT_KEY || '';
// Dev wallets rip without paying (server randomness), still recorded like any rip.
const DEV_ACCOUNTS = (process.env.DEV_ACCOUNTS || D.GAME_ACCOUNT).split(',').map((a) => a.trim()).filter(Boolean);
// Wallets allowed on the admin page (read status, backup price). On-chain changes are still signed
// by the right wallet in the browser.
const ADMIN_ACCOUNTS = (process.env.ADMIN_ACCOUNTS || D.ADMIN_ACCOUNTS.join(',')).split(',').map((a) => a.trim()).filter(Boolean);
const isDev = (st) => Boolean(st && st.user && st.user.chain === 'near' && DEV_ACCOUNTS.includes(st.user.address));
// Payments, randomness and buybacks are on NEAR, so sign-in is NEAR only.
const CHAINS = ['near'];
// Direct mode (no contract yet): players send NEAR straight to the treasury.
const TREASURY = process.env.TREASURY || D.TREASURY;
const YOCTO = 10n ** 24n;
const ROUND = 10n ** 20n; // quotes are rounded up to 0.0001 NEAR

const STATIC = new Set(['index.html', 'css/style.css', 'js/cards.js', 'js/auth.js', 'js/data.js', 'js/engine.js', 'js/store.js', 'js/wallets.js', 'js/app.js', 'js/sha256.js', 'vendor/near-wallet.js', 'vendor/solana-vrf.js', 'contracts/near-rng/res/nearpacks_game.wasm']);
const ART_RE = /^assets\/(art\/\d{1,4}\.webp|brand\/[a-z-]+\.(svg|png))$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/* ---------- tiny JSON database ---------- */
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { users: {}, sessions: {}, settings: {}, usedTx: {}, ...db };
  } catch {
    return { users: {}, sessions: {}, settings: {}, usedTx: {} };
  }
}
const db = loadDb();
for (const id of Object.keys(db.users)) db.users[id] = engine.migrate(db.users[id]);
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}

const nonces = new Map(); // nonce -> issued at
const NONCE_TTL = 10 * 60 * 1000;

function ctx() { return { now: Date.now(), mode: 'server' }; }
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/* ---------- http helpers ---------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(value, maxAge) {
  return `pn_sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (SECURE_COOKIE ? '; Secure' : '');
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function currentUserId(req) {
  const sid = cookies(req).pn_sid;
  return sid && db.sessions[sid] ? db.sessions[sid] : null;
}

/* ---------- wallet sign-in ---------- */
function issueNonce(res) {
  const now = Date.now();
  for (const [k, at] of nonces) if (now - at > NONCE_TTL) nonces.delete(k);
  const nonce = crypto.randomBytes(32).toString('hex');
  nonces.set(nonce, now);
  send(res, 200, { nonce, nearRecipient: auth.NEAR_RECIPIENT, nearNetwork: NEAR_NETWORK });
}

async function walletLogin(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 8192)); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  const { chain, nonce, signature } = body || {};
  const issued = nonces.get(nonce);
  nonces.delete(nonce);
  if (!issued || Date.now() - issued > NONCE_TTL) return send(res, 400, { error: 'Sign-in expired. Try again.' });
  if (!CHAINS.includes(chain)) return send(res, 400, { error: 'Sign in with a NEAR wallet.' });

  let address;
  if (chain === 'solana') {
    address = String(body.address || '');
    if (!auth.isSolanaAddress(address)) return send(res, 400, { error: 'That is not a valid Solana address.' });
    // Verify the exact text the wallet signed, after checking it is our sign-in message.
    const expected = auth.loginMessage('solana', address, nonce);
    const signed = typeof body.message === 'string' ? body.message.replace(/\r\n/g, '\n') : expected;
    if (signed !== expected) return send(res, 400, { error: 'The signed message is not the Near Packs sign-in message. Try again.' });
    if (!verify.verifySolana({ address, signature, message: signed })) {
      console.warn('[solana-login] signature mismatch', { address, wallet: body.wallet, sigLen: String(signature || '').length });
      return send(res, 401, { error: 'The wallet signature did not match this address. If you use a Ledger or a multi-account wallet, select the account you connected and try again.' });
    }
  } else {
    address = String(body.accountId || '');
    if (!auth.isNearAccount(address)) return send(res, 400, { error: 'That is not a valid NEAR account.' });
    const ok = verify.verifyNearSignature({
      publicKey: body.publicKey, signature, message: auth.loginMessage('near', null, nonce),
      nonce: Buffer.from(nonce, 'hex'), recipient: auth.NEAR_RECIPIENT, callbackUrl: body.callbackUrl || undefined
    });
    if (!ok) {
      console.warn('[near-login] signature mismatch', { address, wallet: body.wallet, hasCallback: Boolean(body.callbackUrl) });
      return send(res, 401, { error: 'The NEAR wallet signature did not match. Try again, or pick another NEAR wallet.' });
    }
    try {
      if (!(await withNearRpc((url) => verify.nearKeyBelongsTo(address, verify.nearKeyString(body.publicKey), url)))) {
        return send(res, 401, { error: 'That key is not a full-access key of ' + address + '.' });
      }
    } catch (err) {
      console.error('[near-rpc]', err.message);
      return send(res, 502, { error: 'Could not reach NEAR to confirm your account. Try again.' });
    }
  }

  const id = chain + ':' + address;
  let state0 = db.users[id];
  if (!state0) state0 = engine.apply(engine.emptyState(), { type: 'connect', chain, address, wallet: body.wallet }, ctx()).state;
  db.users[id] = state0;
  const sid = b64url(crypto.randomBytes(32));
  db.sessions[sid] = id;
  saveDb();
  send(res, 200, { state: state0 }, { 'Set-Cookie': sessionCookie(sid, 60 * 60 * 24 * 30) });
}

/* ---------- game config (read from the interaction wallet's contract) ---------- */
let gameCache = { at: 0, ttl: 0, value: null }; // the contract's config, read from chain
async function chainConfig() {
  if (gameCache.value && Date.now() - gameCache.at < gameCache.ttl) return gameCache.value;
  let value;
  try {
    const cfg = await withNearRpc((url) => onchain.nearView(url, GAME_ACCOUNT, 'get_config', {}));
    value = { initialized: Boolean(cfg), treasury: (cfg && cfg.treasury) || null, prices: ((cfg && cfg.prices) || []).map(String) };
    gameCache = { at: Date.now(), ttl: 60000, value };
  } catch (err) {
    value = { initialized: false, treasury: null, prices: [] };
    gameCache = { at: Date.now(), ttl: 15000, value };
  }
  return value;
}

// NEAR/USD now: live market median, else the admin's manual price, else none.
async function marketPrice() {
  const live = await price.nearUsd().catch(() => null);
  if (live) return { usd: live.usd, source: live.sources.join('+'), at: live.at, stale: live.stale };
  const manual = Number((db.settings && db.settings.nearUsd) || process.env.NEAR_USD);
  if (manual > 0) return { usd: manual, source: 'manual', at: null, stale: false };
  return null;
}

// yoctoNEAR for `usdCents` at `usdPerNear`, rounded up to 0.0001 NEAR.
function yoctoFor(usdCents, usdPerNear) {
  const micro = BigInt(Math.round(usdPerNear * 1e6));
  const raw = BigInt(usdCents) * YOCTO * 1000000n / (100n * micro);
  return ((raw + ROUND - 1n) / ROUND) * ROUND;
}

/* Game config. Mode 'contract' once nearpacks.near runs the Near Packs contract, else 'direct'
   (NEAR sent straight to the treasury). Pack prices follow the live NEAR price unless the
   contract has fixed prices set on chain. */
async function gameConfig() {
  const [chain, market] = await Promise.all([chainConfig(), marketPrice()]);
  const fixed = chain.initialized && chain.prices.length >= D.PACKS.length;
  const prices = fixed ? chain.prices : market ? D.PACKS.map((p) => yoctoFor(Math.round(p.usd * 100), market.usd).toString()) : [];
  return {
    account: GAME_ACCOUNT, mode: chain.initialized ? 'contract' : 'direct',
    treasury: chain.initialized ? chain.treasury : TREASURY,
    currency: 'NEAR', decimals: 24, prices, maxPerRip: 5,
    priceSource: fixed ? 'contract' : market ? market.source : null,
    nearUsd: market ? market.usd : null, priceAt: market ? market.at : null,
    ready: prices.length >= D.PACKS.length,
    buyback: chain.initialized && Boolean(PAYOUT_KEY) && Boolean(fixed || market)
  };
}
const notReady = () => ({ error: 'Packs open soon. Follow @' + D.X_HANDLE + ' for the launch.' });

/* ---------- on-chain rips ----------
   start:  reserve a one-time seed. The player calls rip({seed, pack, count}) on GAME_ACCOUNT with the
           price attached in NEAR; the contract checks the price, draws the randomness and forwards
           the NEAR to the treasury in that same transaction (a wrong amount is refunded).
   finish: read the draw from chain, check it is this player's payment for this rip, derive the cards.
   cancel: drop the rip, only while nothing was paid for its seed. */
function payFor(game, pr) {
  if (pr.source === 'near-transfer') return { method: 'transfer', receiver: pr.treasury || TREASURY, deposit: pr.amount };
  const pack = D.PACKS.findIndex((p) => p.id === pr.pack);
  return { method: 'open_pack', receiver: GAME_ACCOUNT, deposit: pr.amount, args: { seed: pr.seed, pack, count: pr.count } };
}

async function ripRoute(req, res, step) {
  const uid = currentUserId(req);
  const st = uid && db.users[uid];
  if (!st) return send(res, 401, { error: 'Connect your wallet first.' });
  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  try {
    const game = await gameConfig();
    if (step === 'start' && isDev(st)) {
      // Dev wallet: no payment; the server draws the randomness and the rip is recorded as a dev rip.
      const seed = crypto.randomBytes(32).toString('hex');
      const started = engine.apply(st, { type: 'ripStart', pack: body.pack, count: body.count, seed, chain: 'near', source: 'dev' }, ctx());
      const out = engine.apply(started.state, { type: 'ripFinish', proof: { randomness: crypto.randomBytes(32).toString('hex'), source: 'dev', ref: st.user.address } }, ctx());
      db.users[uid] = out.state;
      saveDb();
      console.log('[rip] dev rip', { user: st.user.address, pack: body.pack, count: started.result.rip.count });
      return send(res, 200, { state: out.state, rip: started.result.rip, pay: null, result: out.result });
    }
    if (step === 'start') {
      if (!game.ready) return send(res, 503, notReady());
      const index = D.PACKS.findIndex((p) => p.id === body.pack);
      if (index < 0) return send(res, 400, { error: 'That pack is not available.' });
      const count = D.MULTI.includes(body.count) ? body.count : 1;
      const amount = (BigInt(game.prices[index]) * BigInt(count)).toString();
      const seed = crypto.randomBytes(32).toString('hex');
      const source = game.mode === 'direct' ? 'near-transfer' : 'nearpacks-near';
      const out = engine.apply(st, { type: 'ripStart', pack: body.pack, count, seed, amount, chain: 'near', source }, ctx());
      if (source === 'near-transfer') out.state.pendingRip.treasury = game.treasury;
      db.users[uid] = out.state;
      saveDb();
      return send(res, 200, { state: out.state, rip: out.result.rip, pay: payFor(game, out.result.rip) });
    }
    const pr = st.pendingRip;
    if (!pr) return send(res, 400, { error: 'There is no unopened pack.' });
    if (pr.source === 'dev' || (isDev(st) && step === 'cancel')) {
      const out = engine.apply(st, { type: 'ripCancel' }, ctx());
      db.users[uid] = out.state;
      saveDb();
      return send(res, 200, { state: out.state, result: out.result });
    }
    if (pr.source === 'near-transfer') return directRip(req, res, step, uid, st, pr, body, game);
    const r = await withNearRpc((url) => onchain.nearDraw(url, GAME_ACCOUNT, pr.seed));
    if (step === 'cancel') {
      if (r.status !== 'missing') return send(res, 409, { error: 'This pack is already paid. Open it instead.' });
      const out = engine.apply(st, { type: 'ripCancel' }, ctx());
      db.users[uid] = out.state;
      saveDb();
      return send(res, 200, { state: out.state, result: out.result });
    }
    if (r.status !== 'fulfilled') return send(res, 202, { status: r.status, rip: pr, pay: game.ready ? payFor(game, pr) : null });
    const index = D.PACKS.findIndex((p) => p.id === pr.pack);
    if (r.account !== st.user.address || r.pack !== index || r.count !== pr.count || (pr.amount && String(r.amount) !== String(pr.amount))) {
      console.warn('[rip] payment mismatch', { user: st.user.address, draw: r, rip: pr });
      return send(res, 400, { error: 'The payment on chain does not match this pack.' });
    }
    const proof = { randomness: r.randomness, source: 'nearpacks-near', ref: GAME_ACCOUNT, paid: r.amount, tx: typeof body.tx === 'string' ? body.tx.slice(0, 120) : null };
    const out = engine.apply(st, { type: 'ripFinish', proof }, ctx());
    db.users[uid] = out.state;
    saveDb();
    return send(res, 200, { state: out.state, result: out.result });
  } catch (err) {
    if (err.isGameError) return send(res, 400, { error: err.message });
    console.error('[rip]', err.message);
    return send(res, err.status || 502, { error: err.status ? err.message : 'Could not reach NEAR. Try again in a moment.' });
  }
}

/* Direct mode rip: the player sent a plain NEAR transfer to the treasury. The server checks the
   transaction on chain (sender, receiver, exact amount, success, sent after this rip started, never
   used before) and derives the randomness from the hash of the block that included it:
     randomness = sha256("nearpacks-transfer:v1" || block_hash || seed)
   Nobody can know that block hash before the transaction lands, and anyone can re-check it. */
const RIP_TRANSFER_DOMAIN = Buffer.from('nearpacks-transfer:v1');
function transferRandomness(blockHash, seedHex) {
  return crypto.createHash('sha256').update(Buffer.concat([RIP_TRANSFER_DOMAIN, Buffer.from(auth.base58Decode(blockHash)), Buffer.from(seedHex, 'hex')])).digest('hex');
}
async function directRip(req, res, step, uid, st, pr, body, game) {
  const save = (state) => { db.users[uid] = state; saveDb(); };
  if (step === 'cancel') {
    const out = engine.apply(st, { type: 'ripCancel' }, ctx());
    save(out.state);
    return send(res, 200, { state: out.state, result: out.result });
  }
  const given = typeof body.tx === 'string' ? body.tx.trim() : '';
  if (given) {
    const raw = auth.base58Decode(given);
    if (!raw || raw.length !== 32) return send(res, 400, { error: 'That is not a NEAR transaction hash.' });
    st.pendingRip.tx = given;
    save(st);
  }
  const txHash = st.pendingRip.tx;
  if (!txHash) return send(res, 202, { status: 'missing', rip: pr, pay: payFor(game, pr) });
  const usedBy = db.usedTx[txHash];
  if (usedBy && usedBy !== uid + ':' + pr.seed) {
    st.pendingRip.tx = null; save(st);
    return send(res, 400, { error: 'That transaction was already used for another pack.' });
  }
  const t = await withNearRpc((url) => onchain.nearTransferTx(url, txHash, st.user.address));
  if (t.status === 'pending') return send(res, 202, { status: 'pending', rip: pr, pay: payFor(game, pr) });
  const fail = (msg) => { st.pendingRip.tx = null; save(st); return send(res, 400, { error: msg }); };
  if (t.status === 'failed') return fail('That transaction failed on NEAR. Nothing was paid; try again.');
  const treasury = pr.treasury || TREASURY;
  if (t.signer !== st.user.address || t.receiver !== treasury || t.deposit !== String(pr.amount)) {
    console.warn('[rip] transfer mismatch', { user: st.user.address, tx: txHash, t, rip: pr });
    return fail('That transaction is not the payment for this pack (it must send the exact amount to ' + treasury + ').');
  }
  const block = await withNearRpc((url) => onchain.nearBlock(url, t.blockHash));
  if (block.timestampMs < pr.at - 5000) return fail('That payment was sent before this pack was started.');
  db.usedTx[txHash] = uid + ':' + pr.seed;
  const proof = { randomness: transferRandomness(t.blockHash, pr.seed), source: 'near-transfer', ref: treasury, tx: txHash, block: t.blockHash, paid: t.deposit };
  const out = engine.apply(st, { type: 'ripFinish', proof }, ctx());
  save(out.state);
  return send(res, 200, { state: out.state, result: out.result });
}

/* ---------- buyback ----------
   The card value x BUYBACK_RATE is converted to NEAR at the on-chain Starter Pack rate
   (prices[0] for $PACKS[0].usd), then GAME_ACCOUNT.payout() sends it. ref_id makes it pay once. */
const selling = new Set();
async function buybackRoute(req, res) {
  const uid = currentUserId(req);
  const st = uid && db.users[uid];
  if (!st) return send(res, 401, { error: 'Connect your wallet first.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  const uids = [...new Set([].concat(body && (body.uids || body.uid) || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  let dry;
  try { dry = engine.apply(st, { type: 'buyback', uids }, ctx()); } catch (err) {
    if (err.isGameError) return send(res, 400, { error: err.message });
    throw err;
  }
  if (isDev(st)) {
    const out = engine.apply(st, { type: 'buyback', uids, payout: { amount: null, tx: null, dev: true } }, ctx());
    db.users[uid] = out.state;
    saveDb();
    return send(res, 200, { state: out.state, result: out.result });
  }
  const game = await gameConfig();
  if (!game.ready || !game.buyback) return send(res, 503, { error: 'Buyback opens soon.' });
  if (selling.has(uid)) return send(res, 409, { error: 'A sale is already in progress.' });
  const cents = BigInt(Math.round(dry.result.usd * 100));
  // At the live NEAR price (or the contract's fixed prices if set), rounded down to 0.0001 NEAR.
  const amount = game.priceSource === 'contract'
    ? BigInt(game.prices[0]) * cents / BigInt(D.PACKS[0].usd * 100)
    : (cents * YOCTO * 1000000n / (100n * BigInt(Math.round(game.nearUsd * 1e6)))) / ROUND * ROUND;
  if (amount <= 0n) return send(res, 400, { error: 'Nothing to pay for these cards.' });
  const ref = 'sell:' + crypto.createHash('sha256').update(uid + ':' + uids.join(',')).digest('hex').slice(0, 40);
  selling.add(uid);
  try {
    const isPaid = () => withNearRpc((url) => onchain.nearView(url, GAME_ACCOUNT, 'is_paid', { ref_id: ref }));
    let tx = null;
    if (!(await isPaid())) {
      let out;
      try {
        out = await withNearRpc((url) => nearTx.callFunction(url, {
          signerId: GAME_ACCOUNT, secretKey: PAYOUT_KEY, receiverId: GAME_ACCOUNT,
          method: 'payout', args: { receiver_id: st.user.address, amount: amount.toString(), ref_id: ref }
        }));
      } catch (err) {
        out = { ok: false, error: err.message };
      }
      // A retry after a lost response must not report a payout that actually landed as failed.
      if (!(out.ok && out.value === true) && !(await isPaid())) {
        console.error('[buyback] payout failed', { user: st.user.address, ref, out });
        return send(res, 502, { error: 'The payout did not go through. Your cards are still in your vault.' });
      }
      tx = out.hash || null;
    }
    const outState = engine.apply(db.users[uid], { type: 'buyback', uids, payout: { amount: amount.toString(), tx } }, ctx());
    db.users[uid] = outState.state;
    saveDb();
    return send(res, 200, { state: outState.state, result: outState.result });
  } finally {
    selling.delete(uid);
  }
}

/* ---------- admin (admin wallets only) ----------
   Read-only status for the #admin page. Every change (deploy, prices, keys) is a transaction
   the interaction wallet signs in the browser; the server never holds that wallet's keys. */
const EMPTY_CODE = '11111111111111111111111111111111';
function adminOnly(req, res) {
  const uid = currentUserId(req);
  const st = uid && db.users[uid];
  if (!st || st.user.chain !== 'near' || !ADMIN_ACCOUNTS.includes(st.user.address)) {
    send(res, 403, { error: 'Admin is only for ' + ADMIN_ACCOUNTS.join(', ') + '.' });
    return null;
  }
  return st;
}
const safe = (p) => p.catch((err) => ({ error: err.message }));

async function adminStatus(req, res) {
  if (!adminOnly(req, res)) return;
  gameCache = { at: 0, ttl: 0, value: null };
  const [account, config] = await Promise.all([
    safe(withNearRpc((url) => onchain.nearAccount(url, GAME_ACCOUNT))),
    safe(withNearRpc((url) => onchain.nearView(url, GAME_ACCOUNT, 'get_config', {})))
  ]);
  const game = await gameConfig();
  const out = {
    account: GAME_ACCOUNT, network: NEAR_NETWORK,
    mode: game.mode, ready: game.ready, nearUsd: game.nearUsd, priceSource: game.priceSource, priceAt: game.priceAt,
    manualNearUsd: (db.settings && db.settings.nearUsd) || null, directTreasury: TREASURY,
    exists: Boolean(account && !account.error),
    near: account && !account.error ? account.amount : null,
    deployed: Boolean(account && !account.error && account.code_hash && account.code_hash !== EMPTY_CODE),
    initialized: Boolean(config && !config.error),
    config: config && !config.error ? config : null,
    treasury: null,
    payoutKey: { configured: Boolean(PAYOUT_KEY), publicKey: null, onChain: false }
  };
  const treasury = out.config && out.config.treasury;
  if (treasury) {
    const t = await safe(withNearRpc((url) => onchain.nearAccount(url, treasury)));
    out.treasury = { id: treasury, exists: Boolean(t && !t.error), near: t && !t.error ? t.amount : null };
  }
  if (PAYOUT_KEY) {
    try {
      out.payoutKey.publicKey = nearTx.parseSecretKey(PAYOUT_KEY).publicKeyString;
      const ak = await withNearRpc((url) => onchain.nearAccessKey(url, GAME_ACCOUNT, out.payoutKey.publicKey));
      const fc = ak && ak.permission && ak.permission.FunctionCall;
      out.payoutKey.onChain = Boolean(fc && fc.receiver_id === GAME_ACCOUNT && (fc.method_names || []).includes('payout'));
    } catch (err) {
      out.payoutKey.error = err.message;
    }
  }
  send(res, 200, out);
}

// Admin: manual NEAR/USD price, used only when no live price source answers.
async function adminPrice(req, res) {
  if (!adminOnly(req, res)) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  const usd = String(body && body.nearUsd || '').trim();
  if (usd && !D.packPricesRaw(usd, 24)) return send(res, 400, { error: 'Enter the USD price of 1 NEAR, for example 2.50.' });
  db.settings.nearUsd = usd || null;
  saveDb();
  send(res, 200, { ok: true, nearUsd: db.settings.nearUsd });
}

async function balanceRoute(req, res) {
  const uid = currentUserId(req);
  const st = uid && db.users[uid];
  if (!st) return send(res, 401, { error: 'Connect your wallet first.' });
  try {
    const acc = await withNearRpc((url) => onchain.nearAccount(url, st.user.address));
    return send(res, 200, { amount: acc ? String(acc.amount) : '0', decimals: 24, symbol: 'NEAR' });
  } catch (err) {
    return send(res, 502, { error: 'Could not read your balance.' });
  }
}

function leaderboard() {
  return Object.values(db.users)
    .filter((s) => s.user)
    .map((s) => ({
      chain: s.user.chain,
      address: s.user.address,
      name: s.user.name,
      score: engine.vaultValue(s),
      cards: s.vault.length
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '') rel = 'index.html';
  if (!STATIC.has(rel) && !ART_RE.test(rel)) return send(res, 404, 'Not found');
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ART_RE.test(rel) ? 'public, max-age=604800' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

async function route(req, res) {
  let url;
  try { url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  const p = url.pathname;
  if (p === '/api/config') return send(res, 200, { mode: 'live', chains: CHAINS, nearNetwork: NEAR_NETWORK, game: await gameConfig(), devAccounts: DEV_ACCOUNTS, adminAccounts: ADMIN_ACCOUNTS, version: D.VERSION });
  if (p === '/api/buyback' && req.method === 'POST') return buybackRoute(req, res);
  if (p === '/api/balance' && req.method === 'GET') return balanceRoute(req, res);
  if (p === '/api/admin/status' && req.method === 'GET') return adminStatus(req, res);
  if (p === '/api/admin/price' && req.method === 'POST') return adminPrice(req, res);
  if (p === '/api/rip/start' && req.method === 'POST') return ripRoute(req, res, 'start');
  if (p === '/api/rip/finish' && req.method === 'POST') return ripRoute(req, res, 'finish');
  if (p === '/api/rip/cancel' && req.method === 'POST') return ripRoute(req, res, 'cancel');
  if (p === '/api/auth/nonce' && req.method === 'POST') return issueNonce(res);
  if (p === '/api/auth/wallet' && req.method === 'POST') return walletLogin(req, res);
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const sid = cookies(req).pn_sid;
    if (sid) { delete db.sessions[sid]; saveDb(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p === '/api/me' && req.method === 'GET') {
    const uid = currentUserId(req);
    return send(res, 200, { state: uid ? db.users[uid] || null : null });
  }
  if (p === '/api/leaderboard' && req.method === 'GET') return send(res, 200, { rows: leaderboard() });
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  send(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error. Try again.' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Near Packs v${D.VERSION} running at http://localhost:${PORT} (NEAR ${NEAR_NETWORK}, interaction wallet ${GAME_ACCOUNT}, buyback ${PAYOUT_KEY ? 'on' : 'off'})`);
  });
}

module.exports = { server, db, resetGameCache: () => { gameCache = { at: 0, ttl: 0, value: null }; price.reset(); } };

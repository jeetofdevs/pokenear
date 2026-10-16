'use strict';
/* Pokenear server: static files + wallet sign-in (Solana, NEAR) + authoritative game API.
   No runtime dependencies. Sign-in is a signed message with a one-time nonce; no keys,
   no transactions. Game state lives in a JSON file (DB_FILE). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require('../js/engine.js');
const auth = require('../js/auth.js');
const verify = require('./wallet-verify.js');
const onchain = require('./onchain.js');

loadDotEnv(path.join(__dirname, '..', '.env'));

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
const NEAR_NETWORK = process.env.NEAR_NETWORK || 'mainnet';
const NEAR_RPC = process.env.NEAR_RPC || (NEAR_NETWORK === 'testnet' ? 'https://rpc.testnet.near.org' : 'https://rpc.mainnet.near.org');
// On-chain RNG: Solana players use ORAO VRF, NEAR players use the Pokenear RNG contract.
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const SOLANA_RPC = process.env.SOLANA_RPC || (SOLANA_CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
const NEAR_RNG_CONTRACT = process.env.NEAR_RNG_CONTRACT || '';

const STATIC = new Set(['index.html', 'css/style.css', 'js/cards.js', 'js/auth.js', 'js/data.js', 'js/engine.js', 'js/store.js', 'js/wallets.js', 'js/app.js', 'js/sha256.js', 'vendor/near-wallet.js', 'vendor/solana-vrf.js']);
const ART_RE = /^assets\/(art\/\d{1,4}\.webp|brand\/[a-z-]+\.(svg|png))$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    return { users: {}, sessions: {}, refIndex: {}, wlCounter: 0, ...db };
  } catch {
    return { users: {}, sessions: {}, refIndex: {}, wlCounter: 0 };
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

function rng() { return crypto.randomInt(0, 2 ** 32) / 2 ** 32; }
function ctx() { return { rng, now: Date.now(), mode: 'server', nextSpot: () => ++db.wlCounter }; }
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
  if (!auth.CHAINS[chain]) return send(res, 400, { error: 'Choose Solana or NEAR.' });

  let address;
  if (chain === 'solana') {
    address = String(body.address || '');
    if (!auth.isSolanaAddress(address)) return send(res, 400, { error: 'That is not a valid Solana address.' });
    // Verify the exact text the wallet signed, after checking it is our sign-in message.
    const expected = auth.loginMessage('solana', address, nonce);
    const signed = typeof body.message === 'string' ? body.message.replace(/\r\n/g, '\n') : expected;
    if (signed !== expected) return send(res, 400, { error: 'The signed message is not the Pokenear sign-in message. Try again.' });
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
    if (!ok) return send(res, 401, { error: 'The wallet signature did not match. Try again.' });
    try {
      if (!(await verify.nearKeyBelongsTo(address, body.publicKey, NEAR_RPC))) {
        return send(res, 401, { error: 'That key is not a full-access key of ' + address + '.' });
      }
    } catch (err) {
      console.error('[near-rpc]', err.message);
      return send(res, 502, { error: 'Could not reach NEAR to confirm your account. Try again.' });
    }
  }

  const id = chain + ':' + address;
  let state0 = db.users[id];
  if (!state0) {
    const ref = String(body.ref || '').toUpperCase();
    const referrerId = ref && db.refIndex[ref] && db.refIndex[ref] !== id ? db.refIndex[ref] : null;
    state0 = engine.apply(engine.emptyState(), { type: 'connect', chain, address, wallet: body.wallet, ref: referrerId ? ref : '' }, ctx()).state;
    db.refIndex[state0.user.refCode] = id;
    if (referrerId) db.users[referrerId] = engine.apply(db.users[referrerId], { type: 'inviteJoined' }, ctx()).state;
  }
  db.users[id] = state0;
  const sid = b64url(crypto.randomBytes(32));
  db.sessions[sid] = id;
  saveDb();
  send(res, 200, { state: state0 }, { 'Set-Cookie': sessionCookie(sid, 60 * 60 * 24 * 30) });
}

/* ---------- API ---------- */
const CLIENT_ACTIONS = new Set(['daily', 'buyback', 'joinWhitelist']);

async function handleAction(req, res) {
  const uid = currentUserId(req);
  if (!uid || !db.users[uid]) return send(res, 401, { error: 'Connect your wallet first.' });
  let action;
  try { action = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  if (!action || !CLIENT_ACTIONS.has(action.type)) return send(res, 400, { error: 'Unknown action.' });
  try {
    const out = engine.apply(db.users[uid], action, ctx());
    db.users[uid] = out.state;
    saveDb();
    send(res, 200, { state: out.state, result: out.result });
  } catch (err) {
    if (err.isGameError) return send(res, 400, { error: err.message });
    console.error('[action]', err);
    send(res, 500, { error: 'Server error. Try again.' });
  }
}

/* ---------- on-chain rips ----------
   start:  pay with $POKENEAR, get a one-time seed. The player then requests randomness on their
           chain with that seed (ORAO VRF on Solana, draw(seed) on NEAR) from their own wallet.
   finish: the server reads the randomness from chain and derives the cards (engine.cardsFromRandomness).
   cancel: refund, only while no randomness exists for the seed (so a bad roll can never be undone). */
function rngInfo() {
  return {
    solana: { source: 'orao-vrf', program: onchain.ORAO_PROGRAM, cluster: SOLANA_CLUSTER, rpc: process.env.SOLANA_PUBLIC_RPC || SOLANA_RPC },
    near: { source: 'near-rng', contract: NEAR_RNG_CONTRACT || null, network: NEAR_NETWORK }
  };
}

async function readRandomness(user, seed) {
  if (user.chain === 'solana') {
    const r = await onchain.solanaRandomness(SOLANA_RPC, seed);
    return { status: r.status, randomness: r.randomness, ref: r.account, source: 'orao-vrf' };
  }
  if (!NEAR_RNG_CONTRACT) throw Object.assign(new Error('NEAR randomness is not configured on this server.'), { status: 503 });
  const r = await onchain.nearDraw(NEAR_RPC, NEAR_RNG_CONTRACT, seed);
  if (r.status === 'fulfilled' && r.account !== user.address) throw Object.assign(new Error('That draw was made by a different NEAR account.'), { status: 400 });
  return { status: r.status, randomness: r.randomness, ref: NEAR_RNG_CONTRACT, source: 'near-rng' };
}

async function ripRoute(req, res, step) {
  const uid = currentUserId(req);
  const st = uid && db.users[uid];
  if (!st) return send(res, 401, { error: 'Connect your wallet first.' });
  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  try {
    if (step === 'start') {
      if (st.user.chain === 'near' && !NEAR_RNG_CONTRACT) return send(res, 503, { error: 'NEAR randomness is not configured on this server.' });
      const seed = crypto.randomBytes(32).toString('hex');
      const out = engine.apply(st, { type: 'ripStart', pack: body.pack, count: body.count, seed, chain: st.user.chain, source: st.user.chain === 'solana' ? 'orao-vrf' : 'near-rng' }, ctx());
      db.users[uid] = out.state;
      saveDb();
      return send(res, 200, { state: out.state, rip: out.result.rip, rng: rngInfo() });
    }
    const pr = st.pendingRip;
    if (!pr) return send(res, 400, { error: 'There is no open rip.' });
    const r = await readRandomness(st.user, pr.seed);
    if (step === 'cancel') {
      if (r.status !== 'missing') return send(res, 409, { error: 'Randomness was already requested for this rip. Finish it instead.' });
      const out = engine.apply(st, { type: 'ripCancel' }, ctx());
      db.users[uid] = out.state;
      saveDb();
      return send(res, 200, { state: out.state, result: out.result });
    }
    if (r.status !== 'fulfilled') return send(res, 202, { status: r.status, rip: pr, rng: rngInfo() });
    const out = engine.apply(st, { type: 'ripFinish', proof: { randomness: r.randomness, source: r.source, ref: r.ref, tx: typeof body.tx === 'string' ? body.tx.slice(0, 120) : null } }, ctx());
    db.users[uid] = out.state;
    saveDb();
    return send(res, 200, { state: out.state, result: out.result });
  } catch (err) {
    if (err.isGameError) return send(res, 400, { error: err.message });
    console.error('[rip]', err.message);
    return send(res, err.status || 502, { error: err.status ? err.message : 'Could not read randomness from chain. Try again in a moment.' });
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
      cards: s.vault.length,
      wl: Boolean(s.whitelist)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
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
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/api/config') return send(res, 200, { mode: 'live', chains: Object.keys(auth.CHAINS), nearNetwork: NEAR_NETWORK, rng: rngInfo() });
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
  if (p === '/api/action' && req.method === 'POST') return handleAction(req, res);
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
    console.log(`Pokenear running at http://localhost:${PORT} (wallet sign-in: Solana, NEAR ${NEAR_NETWORK})`);
  });
}

module.exports = { server, db };

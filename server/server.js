'use strict';
/* Pokenear server: static files + X (Twitter) OAuth 2.0 PKCE login + authoritative game API.
   No dependencies. Without X_CLIENT_ID/X_REDIRECT_URI it only serves files and the
   front end falls back to demo mode. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const D = require('../js/data.js');
const engine = require('../js/engine.js');

loadDotEnv(path.join(__dirname, '..', '.env'));

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const X_CLIENT_ID = process.env.X_CLIENT_ID || '';
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
const X_REDIRECT_URI = process.env.X_REDIRECT_URI || '';
const X_AUTH_URL = process.env.X_AUTH_URL || 'https://x.com/i/oauth2/authorize';
const X_API_BASE = (process.env.X_API_BASE || 'https://api.x.com').replace(/\/+$/, '');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const LIVE = Boolean(X_CLIENT_ID && X_REDIRECT_URI);
const SECURE_COOKIE = X_REDIRECT_URI.startsWith('https://');

const STATIC = new Set(['index.html', 'css/style.css', 'js/cards.js', 'js/data.js', 'js/engine.js', 'js/store.js', 'js/app.js']);
const ART_RE = /^assets\/art\/\d{1,4}\.webp$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp' };

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

const pending = new Map(); // oauth state -> { verifier, ref, at }
const PENDING_TTL = 10 * 60 * 1000;

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
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
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

/* ---------- X OAuth 2.0 (PKCE) ---------- */
function startLogin(req, res, url) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const ref = (url.searchParams.get('ref') || '').toUpperCase();
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL) pending.delete(k);
  pending.set(state, { verifier, ref: /^[A-Z0-9]{4,12}$/.test(ref) ? ref : '', at: now });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: 'tweet.read users.read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  redirect(res, `${X_AUTH_URL}?${q}`);
}

async function finishLogin(req, res, url) {
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const p = pending.get(state);
  pending.delete(state);
  if (!p || !code || Date.now() - p.at > PENDING_TTL) return redirect(res, '/?x_error=1');
  try {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (X_CLIENT_SECRET) headers.Authorization = 'Basic ' + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${X_API_BASE}/2/oauth2/token`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: X_CLIENT_ID, redirect_uri: X_REDIRECT_URI, code_verifier: p.verifier })
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const token = await tokenRes.json();
    const meRes = await fetch(`${X_API_BASE}/2/users/me?user.fields=profile_image_url`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!meRes.ok) throw new Error(`users/me ${meRes.status}`);
    const me = (await meRes.json()).data;
    if (!me || !me.id || !me.username) throw new Error('users/me: no data');

    let state0 = db.users[me.id];
    if (!state0) {
      const referrerId = p.ref && db.refIndex[p.ref] && db.refIndex[p.ref] !== me.id ? db.refIndex[p.ref] : null;
      const out = engine.apply(engine.emptyState(), {
        type: 'connect', handle: me.username, name: me.name, xId: me.id, avatar: me.profile_image_url, ref: referrerId ? p.ref : ''
      }, ctx());
      state0 = out.state;
      db.refIndex[state0.user.refCode] = me.id;
      if (referrerId) db.users[referrerId] = engine.apply(db.users[referrerId], { type: 'inviteJoined' }, ctx()).state;
    } else {
      // Keep profile fresh if the user renamed their X account.
      state0.user.name = String(me.name || me.username).slice(0, 50);
      state0.user.avatar = me.profile_image_url || state0.user.avatar;
    }
    db.users[me.id] = state0;
    const sid = b64url(crypto.randomBytes(32));
    db.sessions[sid] = me.id;
    saveDb();
    redirect(res, '/#packs', { 'Set-Cookie': sessionCookie(sid, 60 * 60 * 24 * 30) });
  } catch (err) {
    console.error('[x-login]', err.message);
    redirect(res, '/?x_error=1');
  }
}

/* ---------- API ---------- */
const CLIENT_ACTIONS = new Set(['daily', 'pull', 'buyback', 'task', 'joinWhitelist']);

async function handleAction(req, res) {
  const uid = currentUserId(req);
  if (!uid || !db.users[uid]) return send(res, 401, { error: 'Connect your X account first.' });
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

function leaderboard() {
  return Object.values(db.users)
    .filter((s) => s.user)
    .map((s) => ({
      handle: s.user.handle,
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
  if (p === '/api/config') return send(res, 200, { mode: LIVE ? 'live' : 'local', xHandle: D.X_HANDLE });
  if (!LIVE && (p.startsWith('/api/') || p.startsWith('/auth/'))) return send(res, 404, { error: 'X login is not configured on this server.' });
  if (p === '/auth/x/login' && req.method === 'GET') return startLogin(req, res, url);
  if (p === '/auth/x/callback' && req.method === 'GET') return finishLogin(req, res, url);
  if (p === '/auth/logout' && req.method === 'POST') {
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
    console.log(`Pokenear running at http://localhost:${PORT} (${LIVE ? 'live X login' : 'demo mode: set X_CLIENT_ID and X_REDIRECT_URI for X login'})`);
  });
}

module.exports = { server, db };

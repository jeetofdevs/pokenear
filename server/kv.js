'use strict';
/* Redis storage for serverless hosting (Vercel). The server keeps its JSON file unless one of
   these is set (any name prefix, as Vercel's integrations add, also works):
     - Upstash REST: KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + _TOKEN
     - any Redis URL: REDIS_URL or KV_URL (redis:// or rediss://), e.g. Vercel's "Redis" store

   Each collection of the in-memory db is a Redis hash (field -> JSON). A request loads only what
   it needs, the route runs unchanged, and afterwards only the changed fields are written back.
   Requests that change data hold a short global lock so two payments can never interleave. */
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const env = process.env;
// Finds NAME or <PREFIX>_NAME among the environment variables.
function findEnv(names) {
  for (const n of names) if (env[n]) return [n, env[n]];
  for (const k of Object.keys(env).sort()) for (const n of names) if (k.endsWith('_' + n) && env[k]) return [k, env[k]];
  return [null, ''];
}
const [restName, restUrl] = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const REST_URL = restUrl.replace(/\/+$/, '');
const REST_TOKEN = restName ? env[restName.replace(/URL$/, 'TOKEN')] || '' : '';
const [, tcpUrl] = findEnv(['REDIS_URL', 'KV_URL', 'REDIS_TLS_URL']);
const TCP_URL = /^rediss?:\/\//.test(tcpUrl) ? tcpUrl : '';
const transport = REST_URL && REST_TOKEN ? 'rest' : TCP_URL ? 'tcp' : null;
const PREFIX = env.KV_PREFIX || 'np:';
const COLLECTIONS = ['users', 'sessions', 'usedTx', 'settings', 'nonces'];
const LOCK_KEY = PREFIX + 'lock';
const LOCK_MS = 60 * 1000;

const enabled = Boolean(transport);
// Names (never values) of variables that look like Redis settings, to explain a missing connection.
const seenEnv = Object.keys(env).filter((k) => /REDIS|UPSTASH|(^|_)KV_/.test(k)).sort();

/* ---------- Upstash REST ---------- */
async function restCall(body, pathname = '') {
  const res = await fetch(REST_URL + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('Redis HTTP ' + res.status + (json && json.error ? ': ' + json.error : ''));
  return json;
}

/* ---------- plain Redis protocol (RESP) over TCP/TLS ---------- */
function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const a of args) { const b = Buffer.from(String(a)); out += '$' + b.length + '\r\n' + b.toString('binary') + '\r\n'; }
  return Buffer.from(out, 'binary');
}
// -> [value, nextPos] or null when the buffer does not hold a whole reply yet.
function parse(buf, pos) {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, eol);
  const next = eol + 2;
  if (type === '+') return [line, next];
  if (type === '-') return [new Error('Redis: ' + line), next];
  if (type === ':') return [Number(line), next];
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return [null, next];
    if (buf.length < next + len + 2) return null;
    return [buf.toString('utf8', next, next + len), next + len + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, next];
    const arr = [];
    let p = next;
    for (let i = 0; i < n; i++) { const r = parse(buf, p); if (!r) return null; arr.push(r[0]); p = r[1]; }
    return [arr, p];
  }
  return [new Error('Redis: bad reply'), buf.length];
}
let conn = null;
function connection() {
  if (conn && !conn.dead) return conn;
  const u = new URL(TCP_URL);
  const port = Number(u.port) || 6379;
  const sock = u.protocol === 'rediss:' ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
  const c = { sock, buf: Buffer.alloc(0), waiting: [], dead: false };
  sock.on('data', (d) => {
    c.buf = Buffer.concat([c.buf, d]);
    while (c.waiting.length) {
      const r = parse(c.buf, 0);
      if (!r) break;
      c.buf = c.buf.subarray(r[1]);
      c.waiting.shift().done(r[0]);
    }
  });
  const fail = (err) => { c.dead = true; for (const w of c.waiting.splice(0)) w.done(err || new Error('Redis connection closed')); };
  sock.on('error', fail);
  sock.on('close', () => fail());
  sock.setTimeout(15000, () => sock.destroy(new Error('Redis timeout')));
  sock.unref(); // never keeps the process alive by itself
  conn = c;
  const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
  c.auth = pass ? tcpSend(c, [user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]]).then((r) => { if (r[0] instanceof Error) throw r[0]; }) : Promise.resolve();
  const db = (u.pathname || '').replace('/', '');
  if (db && db !== '0') c.auth = c.auth.then(() => tcpSend(c, [['SELECT', db]]));
  return c;
}
function tcpSend(c, cmds) {
  return Promise.all(cmds.map((cmd) => new Promise((resolve) => { c.waiting.push({ done: resolve }); c.sock.write(encode(cmd)); })));
}
async function tcpRun(cmds) {
  const c = connection();
  await c.auth;
  return tcpSend(c, cmds);
}

/* ---------- one interface for both ---------- */
async function cmd(...args) {
  if (transport === 'rest') {
    const out = await restCall(args);
    if (out.error) throw new Error('Redis: ' + out.error);
    return out.result;
  }
  const [r] = await tcpRun([args]);
  if (r instanceof Error) throw r;
  return r;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  if (transport === 'rest') {
    const out = await restCall(cmds, '/pipeline');
    return out.map((r) => { if (r.error) throw new Error('Redis: ' + r.error); return r.result; });
  }
  const res = await tcpRun(cmds);
  return res.map((r) => { if (r instanceof Error) throw r; return r; });
}
const key = (name) => PREFIX + name;
function pairs(flat) {
  const out = {};
  for (let i = 0; flat && i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
  return out;
}

/* ---------- loading into the in-memory db ---------- */
// Fills db (cleared first) with the settings plus the given fields / whole collections.
// want: { all: ['users', ...], fields: { users: ['near:bob.near'], sessions: ['sid'] } }
async function load(db, want, migrate) {
  for (const c of COLLECTIONS) db[c] = {};
  const cmds = [['HGETALL', key('settings')]];
  const plan = [['settings', null]];
  for (const c of want.all || []) if (c !== 'settings') { cmds.push(['HGETALL', key(c)]); plan.push([c, null]); }
  for (const [c, fields] of Object.entries(want.fields || {})) {
    const list = fields.filter(Boolean);
    if (!list.length || (want.all || []).includes(c)) continue;
    cmds.push(['HMGET', key(c), ...list]);
    plan.push([c, list]);
  }
  const results = await pipeline(cmds);
  plan.forEach(([c, fields], i) => {
    if (!fields) Object.assign(db[c], pairs(results[i]));
    else fields.forEach((f, j) => { if (results[i][j] != null) db[c][f] = JSON.parse(results[i][j]); });
  });
  if (migrate) for (const id of Object.keys(db.users)) db.users[id] = migrate(db.users[id]);
  return snapshot(db);
}
// Loads more fields during a request (e.g. the user who is signing in) and adds them to the snapshot.
async function ensure(db, snap, c, fields, migrate) {
  const list = fields.filter((f) => f && !(f in db[c]) && !(f in snap[c]));
  if (!list.length) return;
  const got = await cmd('HMGET', key(c), ...list);
  list.forEach((f, j) => {
    if (got[j] == null) return;
    let v = JSON.parse(got[j]);
    if (c === 'users' && migrate) v = migrate(v);
    db[c][f] = v;
    snap[c][f] = JSON.stringify(v);
  });
}
function snapshot(db) {
  const snap = {};
  for (const c of COLLECTIONS) {
    snap[c] = {};
    for (const [f, v] of Object.entries(db[c] || {})) snap[c][f] = JSON.stringify(v);
  }
  return snap;
}

/* ---------- writing back what changed ---------- */
async function flush(db, snap) {
  const cmds = [];
  for (const c of COLLECTIONS) {
    const now = db[c] || {};
    const set = [];
    for (const [f, v] of Object.entries(now)) {
      const s = JSON.stringify(v);
      if (s !== undefined && s !== snap[c][f]) set.push(f, s);
    }
    const gone = Object.keys(snap[c]).filter((f) => !(f in now));
    if (set.length) cmds.push(['HSET', key(c), ...set]);
    if (gone.length) cmds.push(['HDEL', key(c), ...gone]);
  }
  await pipeline(cmds);
  return cmds.length;
}

/* ---------- global write lock ---------- */
async function lock(waitMs = 25000) {
  const token = crypto.randomBytes(12).toString('hex');
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await cmd('SET', LOCK_KEY, token, 'NX', 'PX', String(LOCK_MS))) === 'OK') return token;
    if (Date.now() > until) throw Object.assign(new Error('busy'), { busy: true });
    await new Promise((r) => setTimeout(r, 120));
  }
}
async function unlock(token) {
  await cmd('EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", '1', LOCK_KEY, token).catch(() => {});
}

function close() { if (conn) { conn.sock.destroy(); conn = null; } }

module.exports = { close, enabled, transport, seenEnv, load, ensure, flush, lock, unlock, cmd, COLLECTIONS };

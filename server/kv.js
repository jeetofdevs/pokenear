'use strict';
/* Upstash Redis storage for serverless hosting (Vercel). Used when KV_REST_API_URL/TOKEN
   (Vercel's Upstash integration) or UPSTASH_REDIS_REST_URL/TOKEN are set; otherwise the server
   keeps its JSON file.

   Each collection of the in-memory db is a Redis hash (field -> JSON). A request loads only what
   it needs, the route runs unchanged, and afterwards only the changed fields are written back.
   Requests that change data hold a short global lock so two payments can never interleave. */
const crypto = require('node:crypto');

const URL_ = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = process.env.KV_PREFIX || 'np:';
const COLLECTIONS = ['users', 'sessions', 'usedTx', 'settings', 'nonces'];
const LOCK_KEY = PREFIX + 'lock';
const LOCK_MS = 60 * 1000;

const enabled = Boolean(URL_ && TOKEN);

async function call(body, pathname = '') {
  const res = await fetch(URL_ + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('Redis HTTP ' + res.status + (json && json.error ? ': ' + json.error : ''));
  return json;
}
async function cmd(...args) {
  const out = await call(args);
  if (out.error) throw new Error('Redis: ' + out.error);
  return out.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const out = await call(cmds, '/pipeline');
  return out.map((r) => { if (r.error) throw new Error('Redis: ' + r.error); return r.result; });
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

module.exports = { enabled, load, ensure, flush, lock, unlock, cmd, COLLECTIONS };

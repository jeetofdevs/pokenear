'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const engine = require('../js/engine.js');
const auth = require('../js/auth.js');

// Small seeded PRNG so tests are repeatable.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = 1_800_000_000_000;
function ctx(seed = 1, now = T) {
  return { rng: mulberry32(seed), now, mode: 'local' };
}
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
function connected(extra = {}) {
  return engine.apply(engine.emptyState(), { type: 'connect', chain: 'solana', address: SOL, ...extra }, ctx()).state;
}
const STARTER = D.packById.starter;

test('only Pokémon sets are loaded', () => {
  assert.ok(D.SERIES.length >= 4);
  assert.ok(D.SERIES.every((s) => s.game === 'pokemon'));
});

test('cheapest pack is $10 and prices convert to $POKENEAR', () => {
  assert.equal(Math.min(...D.PACKS.map((p) => p.usd)), 10);
  assert.equal(STARTER.price, Math.round(10 / D.TOKEN_USD));
});

test('every pack publishes odds that sum to 100% and hit the EV target', () => {
  for (const p of D.PACKS) {
    const sum = p.pool.reduce((n, e) => n + e.p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${p.id} odds sum ${sum}`);
    assert.ok(Math.abs(p.ev - p.usd * D.EV_RATIO) < 0.02, `${p.id} EV ${p.ev}`);
    for (const e of p.pool) {
      const c = D.cardById[e.id];
      assert.ok(c.usd >= p.min && c.usd <= p.max, `${c.id} $${c.usd} outside ${p.id}`);
    }
    // Pricier cards are never more likely than cheaper ones.
    for (let i = 1; i < p.pool.length; i++) assert.ok(p.pool[i].p >= p.pool[i - 1].p - 1e-12);
    assert.ok(p.pool.length >= 20);
  }
});

test('simulated rips match the published odds and EV', () => {
  for (const p of D.PACKS) {
    const rng = mulberry32(11);
    const N = 50000;
    let total = 0;
    let top = 0;
    for (let i = 0; i < N; i++) {
      const c = engine.rip(p, rng);
      total += c.usd;
      if (c.usd >= p.usd) top += 1;
    }
    const ev = total / N;
    assert.ok(Math.abs(ev - p.ev) / p.ev < 0.05, `${p.id}: simulated EV ${ev.toFixed(2)} vs ${p.ev}`);
    assert.ok(Math.abs(top / N - p.beat) < 0.01, `${p.id}: beat ${top / N} vs ${p.beat}`);
  }
});

test('cards are real, unique and valued', () => {
  const ids = new Set();
  for (const c of D.ALL_CARDS) {
    assert.ok(!ids.has(c.id));
    ids.add(c.id);
    assert.ok(c.usd > 0 && c.buyback === Math.round(c.usd * D.BUYBACK_RATE / D.TOKEN_USD));
    assert.match(c.img, /^https:\/\//);
  }
  assert.equal(D.cardById['mew-199'].name, 'Charizard ex');
  assert.equal(D.cardById['mew-199'].code, 'SIR');
});

test('connect validates addresses and grants no credit', () => {
  const bad = (chain, address) => assert.throws(() => engine.apply(engine.emptyState(), { type: 'connect', chain, address }, ctx()), /not a valid|Choose Solana/);
  bad('solana', 'not-a-key');
  bad('solana', '0OIl' + SOL.slice(4));
  bad('near', 'Alice.near');
  bad('near', 'a');
  bad('evm', '0xabc');
  const s = connected();
  assert.equal(s.user.chain, 'solana');
  assert.equal(s.user.name, '7xKX…gAsU');
  assert.equal(s.balance, undefined);
  const n = engine.apply(engine.emptyState(), { type: 'connect', chain: 'near', address: 'pokefan.near' }, ctx()).state;
  assert.equal(n.user.name, 'pokefan.near');
  assert.equal(n.user.refCode, undefined);
});

test('base58 round-trips and validates key length', () => {
  assert.equal(auth.base58Encode(new Uint8Array(32)), '1'.repeat(32)); // all-zero bytes (e.g. a zero hash)
  assert.equal(auth.base58Decode('1'.repeat(32)).length, 32);
  assert.deepEqual([...auth.base58Decode('1112')], [0, 0, 0, 1]);
  const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255);
  const enc = auth.base58Encode(bytes);
  assert.deepEqual(Array.from(auth.base58Decode(enc)), Array.from(bytes));
  assert.ok(auth.isSolanaAddress(enc));
  assert.ok(auth.isSolanaAddress(SOL));
  assert.equal(auth.base58Decode('0abc'), null);
  assert.ok(auth.isNearAccount('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'));
});

const SEED = 'cd'.repeat(32);
const RAND = 'ab'.repeat(64);
// Helper: a full on-chain-style rip (start, then finish with given randomness).
function ripWith(state, pack, count, randomness = RAND, seed = SEED) {
  const started = engine.apply(state, { type: 'ripStart', pack, count, seed, chain: 'solana', source: 'orao-vrf' }, ctx()).state;
  return engine.apply(started, { type: 'ripFinish', proof: { randomness, source: 'orao-vrf', ref: 'acct' } }, ctx());
}

test('actions require a connected wallet', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'ripStart', pack: 'starter', seed: SEED }, ctx()), /Connect your wallet/);
  assert.throws(() => engine.apply(connected(), { type: 'pull', pack: 'starter' }, ctx()), /Unknown action/);
});

test('cards are derived deterministically from on-chain randomness', () => {
  const a = engine.cardsFromRandomness('starter', 5, RAND, SEED).map((c) => c.id);
  const b = engine.cardsFromRandomness('starter', 5, RAND, SEED).map((c) => c.id);
  assert.deepEqual(a, b);
  // Independent re-derivation with node:crypto, following the documented formula.
  const crypto = require('node:crypto');
  const pack = D.packById.starter;
  const expected = [0, 1, 2, 3, 4].map((i) => {
    const h = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('pokenear-rip:v1'), Buffer.from(RAND, 'hex'), Buffer.from(SEED, 'hex'), Buffer.from([i])])).digest();
    const u = h.readUIntBE(0, 6) / 2 ** 48;
    return pack.pool.find((e) => u < e.cum).id;
  });
  assert.deepEqual(a, expected);
  // Different randomness or seed gives a different pull (overwhelmingly likely).
  assert.notDeepEqual(engine.cardsFromRandomness('starter', 5, 'ef'.repeat(64), SEED).map((c) => c.id), a);
  // 32-byte (NEAR) randomness works too.
  assert.equal(engine.cardsFromRandomness('elite', 1, 'ab'.repeat(32), SEED).length, 1);
});

test('uniforms from randomness follow the published odds', () => {
  const crypto = require('node:crypto');
  const p = D.packById.starter;
  let beat = 0, total = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const c = engine.cardsFromRandomness('starter', 1, crypto.randomBytes(64).toString('hex'), crypto.randomBytes(32).toString('hex'))[0];
    total += c.usd;
    if (c.usd >= p.usd) beat++;
  }
  assert.ok(Math.abs(total / N - p.ev) / p.ev < 0.06, 'EV ' + total / N);
  assert.ok(Math.abs(beat / N - p.beat) < 0.015, 'beat ' + beat / N);
});

test('ripStart reserves a seed and the amount to pay; ripFinish delivers cards with proof', () => {
  const s0 = connected();
  const started = engine.apply(s0, { type: 'ripStart', pack: 'starter', count: 1, seed: SEED, amount: '1000', chain: 'near', source: 'pokenear-near' }, ctx());
  assert.equal(started.state.pendingRip.seed, SEED);
  assert.equal(started.state.pendingRip.amount, '1000');
  assert.equal(started.state.vault.length, 0);
  assert.throws(() => engine.apply(started.state, { type: 'ripStart', pack: 'starter', count: 1, seed: SEED }, ctx()), /open rip/);
  assert.throws(() => engine.apply(started.state, { type: 'ripFinish', proof: { randomness: 'zz' } }, ctx()), /Bad randomness/);
  const { state, result } = engine.apply(started.state, { type: 'ripFinish', proof: { randomness: RAND, source: 'pokenear-near', ref: 'pokenearfun.near', tx: 'sig', paid: '1000' } }, ctx());
  assert.equal(state.pendingRip, null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, engine.cardsFromRandomness('starter', 1, RAND, SEED)[0].id);
  assert.deepEqual(state.vault[0].proof, { source: 'pokenear-near', chain: 'near', seed: SEED, randomness: RAND, ref: 'pokenearfun.near', tx: 'sig', paid: '1000' });
  assert.equal(state.totalPulls, 1);
  assert.throws(() => engine.apply(state, { type: 'ripFinish', proof: { randomness: RAND } }, ctx()), /no open rip/);
});

test('5x rip gives 5 unique items', () => {
  const { result } = ripWith(connected(), 'starter', 5);
  assert.equal(result.items.length, 5);
  assert.equal(new Set(result.items.map((i) => i.uid)).size, 5);
});

test('ripCancel drops the open rip', () => {
  const started = engine.apply(connected(), { type: 'ripStart', pack: 'starter', count: 1, seed: SEED }, ctx()).state;
  const { state, result } = engine.apply(started, { type: 'ripCancel' }, ctx());
  assert.equal(result.cancelled, true);
  assert.equal(state.pendingRip, null);
});

test('bad seed or unknown pack is rejected', () => {
  const s = connected();
  assert.throws(() => engine.apply(s, { type: 'ripStart', pack: 'op01', seed: SEED }, ctx()), /not available/);
  assert.throws(() => engine.apply(s, { type: 'ripStart', pack: 'starter', seed: 'xyz' }, ctx()), /Bad rip seed/);
});

test('buyback values cards at 90% and records the payout once', () => {
  const s = ripWith(connected(), 'starter', 1).state;
  const item = s.vault[0];
  const out = engine.apply(s, { type: 'buyback', uid: item.uid, payout: { amount: '900', tx: 'h' } }, ctx());
  assert.equal(out.result.usd, Math.round(D.cardById[item.id].usd * D.BUYBACK_RATE * 100) / 100);
  assert.equal(out.state.vault.length, 0);
  assert.deepEqual(out.state.payouts[0], { at: T, usd: out.result.usd, amount: '900', tx: 'h', cards: 1 });
  assert.throws(() => engine.apply(out.state, { type: 'buyback', uid: item.uid }, ctx()), /no longer in your vault/);
});

test('credit, daily and invite actions are gone', () => {
  const s = connected();
  for (const type of ['daily', 'inviteJoined', 'joinWhitelist', 'task']) assert.throws(() => engine.apply(s, { type }, ctx()), /Unknown action/);
});

test('older saves keep the wallet but drop credits and the vault', () => {
  const x = { v: 4, user: { handle: 'x' }, balance: 1234, tasks: { follow: 1 }, vault: [] };
  assert.deepEqual(engine.migrate(x), engine.emptyState());
  const v5 = { v: 5, user: { chain: 'near', address: 'bob.near', name: 'bob.near', refCode: 'PNX', joinedAt: 5 }, balance: 2000, vault: [{ uid: 1, id: 'mew-207' }] };
  const m = engine.migrate(v5);
  assert.equal(m.v, 6);
  assert.equal(m.user.address, 'bob.near');
  assert.equal(m.balance, undefined);
  assert.equal(m.vault.length, 0);
  const cur = connected();
  assert.equal(engine.migrate(cur), cur);
});

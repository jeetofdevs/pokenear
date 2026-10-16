'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const engine = require('../js/engine.js');

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
function connected(extra = {}) {
  return engine.apply(engine.emptyState(), { type: 'connect', handle: '@near_fan', ...extra }, ctx()).state;
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

test('connect validates handle and grants demo credit', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'connect', handle: 'bad handle!' }, ctx()), /valid X handle/);
  assert.equal(connected().balance, D.ECONOMY.startBonus);
  assert.equal(connected({ ref: 'PNFRIEND1' }).balance, D.ECONOMY.startBonus + D.ECONOMY.referredBonus);
  assert.equal(connected({ ref: engine.refCodeFor('near_fan') }).balance, D.ECONOMY.startBonus);
});

test('actions require a connected X account', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'pull', pack: 'starter' }, ctx()), /Connect your X/);
});

test('a rip charges the pack price and puts one card in the vault', () => {
  const { state, result } = engine.apply(connected(), { type: 'pull', pack: 'starter', count: 1 }, ctx(7));
  assert.equal(result.items.length, 1);
  assert.equal(state.balance, D.ECONOMY.startBonus - STARTER.price);
  assert.equal(state.vault.length, 1);
  assert.equal(state.vault[0].uid, 1);
  assert.ok(STARTER.pool.some((e) => e.id === state.vault[0].id));
  assert.equal(state.totalPulls, 1);
});

test('5x rip costs 5 packs and gives 5 unique items', () => {
  const s = connected();
  s.balance = STARTER.price * 5;
  const { state, result } = engine.apply(s, { type: 'pull', pack: 'starter', count: 5 }, ctx(5));
  assert.equal(result.items.length, 5);
  assert.equal(new Set(result.items.map((i) => i.uid)).size, 5);
  assert.equal(state.balance, 0);
});

test('not enough balance or unknown pack is rejected', () => {
  const s = connected();
  s.balance = 999;
  assert.throws(() => engine.apply(s, { type: 'pull', pack: 'starter' }, ctx()), /costs \$10/);
  assert.throws(() => engine.apply(s, { type: 'pull', pack: 'op01' }, ctx()), /not available/);
  assert.equal(s.balance, 999);
});

test('buyback pays 90% of value once', () => {
  let s = engine.apply(connected(), { type: 'pull', pack: 'starter', count: 1 }, ctx(3)).state;
  const item = s.vault[0];
  const before = s.balance;
  const out = engine.apply(s, { type: 'buyback', uid: item.uid }, ctx());
  assert.equal(out.result.amount, D.cardById[item.id].buyback);
  assert.equal(out.state.balance, before + D.cardById[item.id].buyback);
  assert.equal(out.state.vault.length, 0);
  assert.throws(() => engine.apply(out.state, { type: 'buyback', uid: item.uid }, ctx()), /no longer in your vault/);
});

test('daily reward has a cooldown', () => {
  let s = connected();
  s = engine.apply(s, { type: 'daily' }, ctx(1, T)).state;
  assert.throws(() => engine.apply(s, { type: 'daily' }, ctx(1, T + 1000)), /ready in/);
  s = engine.apply(s, { type: 'daily' }, ctx(1, T + D.ECONOMY.dailyCooldownMs)).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + 2 * D.ECONOMY.dailyReward);
});

test('quests pay once', () => {
  let s = connected();
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  assert.throws(() => engine.apply(s, { type: 'task', id: 'follow' }, ctx()), /already/);
});

test('whitelist requires every quest', () => {
  let s = connected();
  assert.throws(() => engine.apply(s, { type: 'joinWhitelist' }, ctx()), /Finish every quest/);
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  s = engine.apply(s, { type: 'task', id: 'post' }, ctx()).state;
  for (let i = 0; i < 3; i++) s = engine.apply(s, { type: 'inviteJoined' }, ctx()).state;
  s = engine.apply(s, { type: 'pull', pack: 'starter' }, ctx()).state;
  assert.equal(engine.whitelistStatus(s).eligible, true);
  assert.equal(engine.apply(s, { type: 'joinWhitelist' }, { ...ctx(), nextSpot: () => 42 }).result.spot, 42);
});

test('old saves migrate without losing balance or quests', () => {
  const old = { v: 3, user: { handle: 'x' }, balance: 1234, earned: 2000, tasks: { follow: 1 }, invites: 2, collection: { 'mew-001': 3 }, totalPulls: 20 };
  const st = engine.migrate(old);
  assert.equal(st.v, 4);
  assert.equal(st.balance, 1234);
  assert.equal(st.invites, 2);
  assert.deepEqual(st.vault, []);
});

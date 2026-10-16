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

function ctx(seed = 1, now = 1_800_000_000_000) {
  return { rng: mulberry32(seed), now, mode: 'local' };
}

function connected(extra = {}) {
  return engine.apply(engine.emptyState(), { type: 'connect', handle: '@near_fan', ...extra }, ctx()).state;
}

test('rarity rates sum to 1', () => {
  const sum = D.RARITIES.reduce((s, r) => s + r.rate, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('cards come from real sets with unique ids and source images', () => {
  const ids = new Set();
  for (const s of D.SERIES) {
    assert.ok(s.cards.length > 100, `${s.id} has ${s.cards.length} cards`);
    for (const c of s.cards) {
      assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
      ids.add(c.id);
      assert.match(c.img, /^https:\/\//);
      assert.ok(c.name && c.rarity && c.tier);
    }
  }
  assert.ok(D.cardById['mew-006'].name === 'Charizard ex');
});

test('every series has a card at every rarity', () => {
  for (const s of D.SERIES) {
    for (const r of D.RARITIES) assert.ok(s.byRarity[r.id].length > 0, `${s.id} missing ${r.id}`);
  }
});

test('connect validates handle and grants bonus', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'connect', handle: 'bad handle!' }, ctx()), /valid X handle/);
  const s = connected();
  assert.equal(s.user.handle, 'near_fan');
  assert.equal(s.balance, D.ECONOMY.startBonus);
  assert.ok(s.user.refCode.startsWith('PN'));
});

test('referral link adds bonus but not for own code', () => {
  const own = engine.refCodeFor('near_fan');
  assert.equal(connected({ ref: own }).balance, D.ECONOMY.startBonus);
  const s = connected({ ref: 'PNFRIEND1' });
  assert.equal(s.user.referredBy, 'PNFRIEND1');
  assert.equal(s.balance, D.ECONOMY.startBonus + D.ECONOMY.referredBonus);
});

test('actions require a connected X account', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'pull', series: 'mew', count: 1 }, ctx()), /Connect your X/);
});

test('pull charges price and adds cards', () => {
  const { state, result } = engine.apply(connected(), { type: 'pull', series: 'op05', count: 10 }, ctx(7));
  assert.equal(result.cards.length, 10);
  assert.equal(state.balance, D.ECONOMY.startBonus - D.ECONOMY.tenPrice);
  assert.equal(state.totalPulls, 10);
  const owned = Object.values(state.collection).reduce((a, b) => a + b, 0);
  assert.equal(owned, 10);
  assert.ok(result.cards.every((c) => D.cardById[c.id].series === 'op05'));
});

test('not enough balance is rejected without changing state', () => {
  const s = connected();
  s.balance = 50;
  assert.throws(() => engine.apply(s, { type: 'pull', series: 'mew', count: 1 }, ctx()), /Not enough/);
  assert.equal(s.balance, 50);
});

test('10-pull always contains SR or better', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const s = connected();
    const { result } = engine.apply(s, { type: 'pull', series: 'mew', count: 10 }, ctx(seed));
    const best = Math.max(...result.cards.map((c) => D.rarityById[D.cardById[c.id].tier].tier));
    assert.ok(best >= D.rarityById.SR.tier, `seed ${seed}`);
  }
});

test('pity guarantees UR or better within the pity window', () => {
  const s = connected();
  s.balance = 1e9;
  const alwaysCommon = () => 0; // rng 0 always rolls the lowest available tier
  let state = s;
  let gotUR = false;
  for (let i = 0; i < D.ECONOMY.pity; i++) {
    const out = engine.apply(state, { type: 'pull', series: 'op01', count: 1 }, { rng: alwaysCommon, now: 1, mode: 'local' });
    state = out.state;
    const tier = D.rarityById[D.cardById[out.result.cards[0].id].tier].tier;
    if (tier >= D.rarityById.UR.tier) { gotUR = true; assert.equal(i, D.ECONOMY.pity - 1); }
  }
  assert.ok(gotUR);
  assert.equal(state.pulls.op01.sinceUR, 0);
});

test('observed rates roughly match published rates', () => {
  const rng = mulberry32(42);
  const counts = {};
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const r = engine.rollRarity(rng, 0);
    counts[r.id] = (counts[r.id] || 0) + 1;
  }
  for (const r of D.RARITIES) {
    assert.ok(Math.abs(counts[r.id] / N - r.rate) < 0.01, `${r.id} ${counts[r.id] / N}`);
  }
});

test('daily reward has a cooldown', () => {
  const T = 1_800_000_000_000;
  let s = connected();
  s = engine.apply(s, { type: 'daily' }, ctx(1, T)).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + D.ECONOMY.dailyReward);
  assert.throws(() => engine.apply(s, { type: 'daily' }, ctx(1, T + 1000)), /ready in/);
  s = engine.apply(s, { type: 'daily' }, ctx(1, T + D.ECONOMY.dailyCooldownMs)).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + 2 * D.ECONOMY.dailyReward);
});

test('burnDupes keeps one copy of each card', () => {
  const s = connected();
  const common = D.seriesById.mew.byRarity.C[0].id;
  const ultra = D.seriesById.mew.byRarity.UR[0].id;
  const other = D.seriesById.op01.byRarity.C[0].id;
  s.collection = { [common]: 4, [ultra]: 2, [other]: 1 };
  const { state, result } = engine.apply(s, { type: 'burnDupes' }, ctx());
  assert.deepEqual(state.collection, { [common]: 1, [ultra]: 1, [other]: 1 });
  assert.equal(result.amount, 3 * 5 + 1 * 250);
  assert.throws(() => engine.apply(state, { type: 'burnDupes' }, ctx()), /No duplicate/);
});

test('quests pay once', () => {
  let s = connected();
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + 100);
  assert.throws(() => engine.apply(s, { type: 'task', id: 'follow' }, ctx()), /already/);
  assert.throws(() => engine.apply(s, { type: 'task', id: 'invites' }, ctx()), /Unknown quest/);
});

test('set bonus requires full set', () => {
  const s = connected();
  assert.throws(() => engine.apply(s, { type: 'claimSet', series: 'meg' }, ctx()), /every card/);
  D.seriesById.meg.cards.forEach((c) => { s.collection[c.id] = 1; });
  const { state } = engine.apply(s, { type: 'claimSet', series: 'meg' }, ctx());
  assert.equal(state.balance, D.ECONOMY.startBonus + D.ECONOMY.setBonus);
  assert.throws(() => engine.apply(state, { type: 'claimSet', series: 'meg' }, ctx()), /already/);
});

test('whitelist requires every quest', () => {
  let s = connected();
  assert.throws(() => engine.apply(s, { type: 'joinWhitelist' }, ctx()), /Finish every quest/);
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  s = engine.apply(s, { type: 'task', id: 'post' }, ctx()).state;
  for (let i = 0; i < 3; i++) s = engine.apply(s, { type: 'inviteJoined' }, ctx()).state;
  s = engine.apply(s, { type: 'pull', series: 'blk', count: 10 }, ctx()).state;
  assert.equal(engine.whitelistStatus(s).eligible, true);
  const { state, result } = engine.apply(s, { type: 'joinWhitelist' }, { ...ctx(), nextSpot: () => 42 });
  assert.equal(result.spot, 42);
  assert.equal(state.whitelist.spot, 42);
  assert.throws(() => engine.apply(state, { type: 'joinWhitelist' }, ctx()), /already/);
});

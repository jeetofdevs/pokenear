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
const PACK = D.productById.pack;
const BUNDLE = D.productById.bundle;

test('only Pokémon sets are live, One Piece is coming soon', () => {
  assert.ok(D.SERIES.length >= 4);
  assert.ok(D.SERIES.every((s) => s.game === 'pokemon'));
  assert.ok(D.COMING_SOON.length >= 1 && D.COMING_SOON.every((s) => s.game === 'onepiece'));
});

test('cheapest product is $10 and prices convert to $POKENEAR', () => {
  assert.equal(Math.min(...D.PRODUCTS.map((p) => p.usd)), 10);
  assert.equal(PACK.price, Math.round(10 / D.TOKEN_USD));
  assert.equal(BUNDLE.packs, 6);
});

test('cards are real, unique and have known rarities', () => {
  const ids = new Set();
  for (const s of D.SERIES) {
    for (const c of s.cards) {
      assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
      ids.add(c.id);
      assert.ok(D.RARITY_INFO[c.rarity], `unknown rarity ${c.rarity}`);
      assert.match(c.img, /^https:\/\//);
    }
  }
  assert.equal(D.cardById['mew-006'].name, 'Charizard ex');
  assert.equal(D.cardById['mew-199'].code, 'SIR');
});

test('a pack follows the real booster layout', () => {
  const s = D.seriesById.mew;
  const rng = mulberry32(3);
  for (let n = 0; n < 2000; n++) {
    const pack = engine.openPack(s, rng).map((c) => ({ ...c, card: D.cardById[c.id] }));
    assert.equal(pack.length, 10);
    pack.slice(0, 4).forEach((c) => assert.equal(c.card.rarity, 'Common'));
    pack.slice(4, 7).forEach((c) => assert.equal(c.card.rarity, 'Uncommon'));
    assert.ok(['Common', 'Uncommon', 'Rare'].includes(pack[7].card.rarity));
    assert.ok(pack[7].rev);
    assert.ok(['Common', 'Uncommon', 'Rare', 'Illustration rare', 'Special illustration rare'].includes(pack[8].card.rarity));
    assert.ok(['Rare', 'Double rare', 'Ultra Rare', 'Hyper rare'].includes(pack[9].card.rarity), pack[9].card.rarity);
    assert.ok(pack.every((c) => c.card.series === 'mew'));
  }
});

test('hit rates match the published 1-in-N odds', () => {
  const s = D.seriesById.mew;
  const rng = mulberry32(42);
  const N = 60000;
  const seen = {};
  for (let n = 0; n < N; n++) {
    const rarities = new Set(engine.openPack(s, rng).map((c) => D.cardById[c.id].rarity));
    rarities.forEach((r) => { seen[r] = (seen[r] || 0) + 1; });
  }
  // A hit only gets its roll if the rarer hits before it in the same slot missed.
  const expect = {
    'Special illustration rare': 1 / 32,
    'Illustration rare': (1 - 1 / 32) / 12,
    'Hyper rare': 1 / 55,
    'Ultra Rare': (1 - 1 / 55) / 16,
    'Double rare': (1 - 1 / 55) * (1 - 1 / 16) / 6
  };
  for (const [r, p] of Object.entries(expect)) {
    const got = seen[r] / N;
    assert.ok(Math.abs(got - p) / p < 0.12, `${r}: got ${got.toFixed(4)} want ${p.toFixed(4)}`);
  }
});

test('set-only hits appear only in their sets', () => {
  const rng = mulberry32(9);
  for (let n = 0; n < 3000; n++) {
    engine.openPack(D.seriesById.mew, rng).forEach((c) => {
      assert.ok(!['Black White Rare', 'Mega Hyper Rare'].includes(D.cardById[c.id].rarity));
    });
  }
  assert.ok(D.seriesById.blk.odds.some((o) => o.code === 'BWR'));
  assert.ok(D.seriesById.meg.odds.some((o) => o.code === 'MUR'));
});

test('connect validates handle and grants demo credit', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'connect', handle: 'bad handle!' }, ctx()), /valid X handle/);
  const s = connected();
  assert.equal(s.user.handle, 'near_fan');
  assert.equal(s.balance, D.ECONOMY.startBonus);
});

test('referral link adds bonus but not for own code', () => {
  assert.equal(connected({ ref: engine.refCodeFor('near_fan') }).balance, D.ECONOMY.startBonus);
  const s = connected({ ref: 'PNFRIEND1' });
  assert.equal(s.balance, D.ECONOMY.startBonus + D.ECONOMY.referredBonus);
});

test('actions require a connected X account', () => {
  assert.throws(() => engine.apply(engine.emptyState(), { type: 'pull', series: 'mew', product: 'pack' }, ctx()), /Connect your X/);
});

test('buying a pack charges $10 and adds 10 cards', () => {
  const { state, result } = engine.apply(connected(), { type: 'pull', series: 'blk', product: 'pack' }, ctx(7));
  assert.equal(result.packs.length, 1);
  assert.equal(result.packs[0].length, 10);
  assert.equal(state.balance, D.ECONOMY.startBonus - PACK.price);
  assert.equal(state.totalPulls, 10);
  assert.equal(state.pulls.blk.packs, 1);
  assert.equal(Object.values(state.collection).reduce((a, b) => a + b, 0), 10);
});

test('bundle opens 6 packs', () => {
  const s = connected();
  s.balance = BUNDLE.price;
  const { state, result } = engine.apply(s, { type: 'pull', series: 'meg', product: 'bundle' }, ctx(5));
  assert.equal(result.packs.length, 6);
  assert.equal(state.balance, 0);
  assert.equal(state.totalPulls, 60);
});

test('not enough balance or unknown set is rejected without changing state', () => {
  const s = connected();
  s.balance = 999;
  assert.throws(() => engine.apply(s, { type: 'pull', series: 'mew', product: 'pack' }, ctx()), /costs \$10/);
  assert.equal(s.balance, 999);
  assert.throws(() => engine.apply(s, { type: 'pull', series: 'op01', product: 'pack' }, ctx()), /not available/);
});

test('daily reward has a cooldown', () => {
  let s = connected();
  s = engine.apply(s, { type: 'daily' }, ctx(1, T)).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + D.ECONOMY.dailyReward);
  assert.throws(() => engine.apply(s, { type: 'daily' }, ctx(1, T + 1000)), /ready in/);
  s = engine.apply(s, { type: 'daily' }, ctx(1, T + D.ECONOMY.dailyCooldownMs)).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + 2 * D.ECONOMY.dailyReward);
});

test('burnDupes sells extras back at their rarity value', () => {
  const s = connected();
  const common = D.seriesById.mew.byRarity.Common[0];
  const sir = D.seriesById.mew.byRarity['Special illustration rare'][0];
  s.collection = { [common.id]: 4, [sir.id]: 2 };
  const { state, result } = engine.apply(s, { type: 'burnDupes' }, ctx());
  assert.deepEqual(state.collection, { [common.id]: 1, [sir.id]: 1 });
  assert.equal(result.amount, 3 * common.value + sir.value);
  assert.throws(() => engine.apply(state, { type: 'burnDupes' }, ctx()), /No duplicate/);
});

test('quests pay once', () => {
  let s = connected();
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  assert.equal(s.balance, D.ECONOMY.startBonus + 100);
  assert.throws(() => engine.apply(s, { type: 'task', id: 'follow' }, ctx()), /already/);
});

test('set bonus requires the full set', () => {
  const s = connected();
  assert.throws(() => engine.apply(s, { type: 'claimSet', series: 'wht' }, ctx()), /every card/);
  D.seriesById.wht.cards.forEach((c) => { s.collection[c.id] = 1; });
  const { state } = engine.apply(s, { type: 'claimSet', series: 'wht' }, ctx());
  assert.equal(state.balance, D.ECONOMY.startBonus + D.ECONOMY.setBonus);
});

test('whitelist requires every quest', () => {
  let s = connected();
  assert.throws(() => engine.apply(s, { type: 'joinWhitelist' }, ctx()), /Finish every quest/);
  s = engine.apply(s, { type: 'task', id: 'follow' }, ctx()).state;
  s = engine.apply(s, { type: 'task', id: 'post' }, ctx()).state;
  for (let i = 0; i < 3; i++) s = engine.apply(s, { type: 'inviteJoined' }, ctx()).state;
  s = engine.apply(s, { type: 'pull', series: 'mew', product: 'pack' }, ctx()).state;
  assert.equal(engine.whitelistStatus(s).eligible, true);
  const { result } = engine.apply(s, { type: 'joinWhitelist' }, { ...ctx(), nextSpot: () => 42 });
  assert.equal(result.spot, 42);
});

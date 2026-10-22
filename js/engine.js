/* Pokenear game engine. Pure state transitions, no DOM and no storage.
   The browser runs it locally in demo mode; the Node server runs the same
   code authoritatively. Payments are real NEAR transfers checked on chain by the
   server, so the state holds no balance. */
(function (root) {
  'use strict';

  var D = root.PN && root.PN.data ? root.PN.data : require('./data.js');
  var A = root.PN && root.PN.auth ? root.PN.auth : require('./auth.js');
  var H = root.PN && root.PN.sha256 ? root.PN.sha256 : require('./sha256.js');

  function GameError(message) {
    var err = new Error(message);
    err.name = 'GameError';
    err.isGameError = true;
    return err;
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function emptyState() {
    return {
      v: 6,
      user: null,
      vault: [],          // pulled cards you still hold: { uid, id, pack, at, proof, n }
      nextUid: 1,
      sold: 0,            // cards sold back
      pulls: {},          // rips per pack
      totalPulls: 0,
      history: [],
      payouts: [],        // buyback payouts: { at, usd, amount, tx }
      pendingRip: null    // rip waiting for its on-chain payment + randomness
    };
  }

  // v6 replaced demo credits with real on-chain payments: keep the wallet, start a fresh vault.
  function migrate(old) {
    if (!old || old.v === 6) return old;
    var st = emptyState();
    if (old.user && old.user.chain) {
      st.user = { chain: old.user.chain, address: old.user.address, name: old.user.name, wallet: old.user.wallet || null, joinedAt: old.user.joinedAt || 0 };
    }
    return st;
  }

  function pickByU(pack, u) {
    var pool = pack.pool;
    for (var i = 0; i < pool.length; i++) if (u < pool[i].cum) return D.cardById[pool[i].id];
    return D.cardById[pool[pool.length - 1].id];
  }
  function rip(pack, rng) { return pickByU(pack, rng()); }

  /* Turn on-chain randomness into card picks. Public and deterministic, so anyone can
     re-derive a rip from its seed and randomness:
       h_i = sha256("pokenear-rip:v1" || randomness || seed || i)
       u_i = first 6 bytes of h_i as an integer / 2^48
       card_i = first card in the pack's published list whose cumulative chance exceeds u_i */
  var RIP_DOMAIN = H.utf8('pokenear-rip:v1');
  function uniformsFromRandomness(randomnessHex, seedHex, count) {
    var r = H.hexToBytes(randomnessHex);
    var sd = H.hexToBytes(seedHex);
    var out = [];
    for (var i = 0; i < count; i++) {
      var h = H.sha256(H.concat([RIP_DOMAIN, r, sd, new Uint8Array([i])]));
      var n = 0;
      for (var b = 0; b < 6; b++) n = n * 256 + h[b];
      out.push(n / 281474976710656);
    }
    return out;
  }
  function cardsFromRandomness(packId, count, randomnessHex, seedHex) {
    var pack = D.packById[packId];
    return uniformsFromRandomness(randomnessHex, seedHex, count).map(function (u) { return pickByU(pack, u); });
  }

  function isHex(s, bytes) { return typeof s === 'string' && new RegExp('^[0-9a-f]{' + bytes * 2 + '}$').test(s); }

  function seriesProgress(state, seriesId) {
    var s = D.seriesById[seriesId];
    var have = {};
    state.vault.forEach(function (it) { have[it.id] = true; });
    var owned = s.cards.filter(function (card) { return have[card.id]; }).length;
    return { owned: owned, total: s.cards.length };
  }

  // Total estimated value of the cards in the vault, in USD.
  function vaultValue(state) {
    return Math.round(state.vault.reduce(function (n, it) { return n + (D.cardById[it.id] ? D.cardById[it.id].usd : 0); }, 0) * 100) / 100;
  }

  function requireUser(state) {
    if (!state.user) throw GameError('Connect your wallet first.');
  }

  /* apply(state, action, ctx) -> { state, result }
     ctx: { now: ms, mode: 'local' | 'server' } */
  function apply(prev, action, ctx) {
    var state = clone(prev || emptyState());
    var now = ctx.now;
    var result = {};
    switch (action && action.type) {
      case 'connect': {
        var chain = action.chain;
        var address = String(action.address || '');
        if (!A.CHAINS[chain]) throw GameError('Choose Solana or NEAR.');
        if (!A.isValidAddress(chain, address)) throw GameError('That is not a valid ' + A.CHAINS[chain].name + ' address.');
        if (state.user) throw GameError('A wallet is already connected.');
        state.user = {
          chain: chain,
          address: address,
          name: A.shortAddress(address),
          wallet: action.wallet ? String(action.wallet).slice(0, 30) : null,
          joinedAt: now
        };
        break;
      }
      case 'ripStart': {
        // Reserve a seed for a rip. The player then pays on chain; the payment draws the randomness.
        requireUser(state);
        if (state.pendingRip) throw GameError('Finish or cancel your unopened pack first.');
        var pack = D.packById[action.pack];
        if (!pack) throw GameError('That pack is not available.');
        var count = D.MULTI.indexOf(action.count) >= 0 ? action.count : 1;
        if (!isHex(action.seed, 32)) throw GameError('Bad rip seed.');
        state.pendingRip = { seed: action.seed, pack: pack.id, count: count, amount: action.amount || null, chain: action.chain || null, source: action.source || null, at: now };
        result.rip = state.pendingRip;
        break;
      }
      case 'ripFinish': {
        requireUser(state);
        var pr = state.pendingRip;
        if (!pr) throw GameError('There is no unopened pack.');
        var proof = action.proof || {};
        var randomness = String(proof.randomness || '');
        if (!(isHex(randomness, 32) || isHex(randomness, 64))) throw GameError('Bad randomness.');
        var cards = cardsFromRandomness(pr.pack, pr.count, randomness, pr.seed);
        var stored = { source: proof.source || pr.source, chain: pr.chain, seed: pr.seed, randomness: randomness, ref: proof.ref || null, tx: proof.tx || null, paid: proof.paid || pr.amount || null };
        if (proof.block) stored.block = String(proof.block).slice(0, 60); // direct transfers: block whose hash seeded the draw
        var items = cards.map(function (card, k) {
          var item = { uid: state.nextUid++, id: card.id, pack: pr.pack, at: now, proof: stored, n: k };
          state.vault.push(item);
          state.history.unshift({ id: card.id, at: now });
          return item;
        });
        state.pulls[pr.pack] = (state.pulls[pr.pack] || 0) + pr.count;
        state.totalPulls += pr.count;
        state.history = state.history.slice(0, D.HISTORY_SIZE);
        state.pendingRip = null;
        result.items = items;
        result.proof = stored;
        break;
      }
      case 'ripCancel': {
        // Drop an unpaid rip (the server checks nothing was paid for its seed).
        requireUser(state);
        if (!state.pendingRip) throw GameError('There is no unopened pack.');
        state.pendingRip = null;
        result.cancelled = true;
        break;
      }
      case 'buyback': {
        requireUser(state);
        var uids = [].concat(action.uids || action.uid || []);
        if (!uids.length) throw GameError('Choose a card to sell back.');
        var usd = 0, soldN = 0;
        uids.forEach(function (uid) {
          var idx = -1;
          for (var i = 0; i < state.vault.length; i++) if (state.vault[i].uid === uid) { idx = i; break; }
          if (idx < 0) throw GameError('That card is no longer in your vault.');
          usd += D.cardById[state.vault[idx].id].usd * D.BUYBACK_RATE;
          state.vault.splice(idx, 1);
          soldN += 1;
        });
        usd = Math.round(usd * 100) / 100;
        // payout: what the server actually sent on chain ({ amount, tx }); absent in demo mode.
        var payout = action.payout || {};
        state.payouts.unshift({ at: now, usd: usd, amount: payout.amount || null, tx: payout.tx || null, cards: soldN });
        state.payouts = state.payouts.slice(0, 20);
        state.sold += soldN;
        result.usd = usd;
        result.sold = soldN;
        result.payout = payout;
        break;
      }
      default:
        throw GameError('Unknown action.');
    }
    return { state: state, result: result };
  }

  var engine = {
    apply: apply,
    emptyState: emptyState,
    migrate: migrate,
    rip: rip,
    pickByU: pickByU,
    uniformsFromRandomness: uniformsFromRandomness,
    cardsFromRandomness: cardsFromRandomness,
    seriesProgress: seriesProgress,
    vaultValue: vaultValue
  };

  root.PN = root.PN || {};
  root.PN.engine = engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

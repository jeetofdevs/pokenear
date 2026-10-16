/* Pokenear game engine. Pure state transitions, no DOM and no storage.
   The browser runs it locally in demo mode; the Node server runs the same
   code authoritatively when X login is configured. */
(function (root) {
  'use strict';

  var D = root.PN && root.PN.data ? root.PN.data : require('./data.js');
  var A = root.PN && root.PN.auth ? root.PN.auth : require('./auth.js');
  var H = root.PN && root.PN.sha256 ? root.PN.sha256 : require('./sha256.js');
  var E = D.ECONOMY;

  function GameError(message) {
    var err = new Error(message);
    err.name = 'GameError';
    err.isGameError = true;
    return err;
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function refCodeFor(chain, address) {
    var code = D.hash('pokenear:' + chain + ':' + address).toString(36).toUpperCase();
    return ('PN' + code).slice(0, 8);
  }

  function emptyState() {
    return {
      v: 5,
      user: null,
      balance: 0,
      earned: 0,
      vault: [],          // pulled cards you still hold: { uid, id, pack, at }
      nextUid: 1,
      sold: 0,            // cards sold back
      pulls: {},          // rips per pack
      totalPulls: 0,
      tasks: {},
      invites: 0,
      lastDaily: 0,
      whitelist: null,
      history: [],
      pendingRip: null    // paid rip waiting for its on-chain randomness
    };
  }

  // Carry an account from an older save format: keep balance and quests, start a fresh vault.
  // Saves from before wallet sign-in (v4 and older, X accounts) cannot be mapped to a wallet.
  function migrate(old) {
    if (!old || old.v === 5) return old;
    if (!old.user || !old.user.chain) return emptyState();
    var st = emptyState();
    ['user', 'balance', 'earned', 'tasks', 'invites', 'lastDaily', 'whitelist'].forEach(function (k) {
      if (old[k] !== undefined) st[k] = old[k];
    });
    st.totalPulls = old.totalPulls ? 1 : 0;
    return st;
  }

  function credit(state, amount) {
    state.balance += amount;
    state.earned += amount;
  }

  // Pick a card from the pack pool for a uniform number u in [0, 1).
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

  function whitelistStatus(state) {
    var checks = {
      connect: !!state.user,
      invites: state.invites >= E.whitelistInvites,
      pulls: state.totalPulls >= E.whitelistPulls
    };
    var done = Object.keys(checks).filter(function (k) { return checks[k]; }).length;
    return { checks: checks, done: done, total: Object.keys(checks).length, eligible: done === Object.keys(checks).length };
  }

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
     ctx: { rng: () => [0,1), now: ms, mode: 'local' | 'server', nextSpot?: () => int } */
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
          refCode: refCodeFor(chain, address),
          referredBy: null,
          joinedAt: now
        };
        state.tasks.connect = now;
        credit(state, E.startBonus);
        result.bonus = E.startBonus;
        var ref = String(action.ref || '').toUpperCase();
        if (ref && /^[A-Z0-9]{4,12}$/.test(ref) && ref !== state.user.refCode) {
          state.user.referredBy = ref;
          credit(state, E.referredBonus);
          result.bonus += E.referredBonus;
          result.referred = true;
        }
        break;
      }
      case 'daily': {
        requireUser(state);
        var wait = state.lastDaily + E.dailyCooldownMs - now;
        if (wait > 0) throw GameError('Daily reward is ready in ' + Math.ceil(wait / 3600000) + 'h.');
        state.lastDaily = now;
        credit(state, E.dailyReward);
        result.amount = E.dailyReward;
        break;
      }
      case 'ripStart': {
        // Pay for a rip and reserve its seed. The cards are decided later by on-chain randomness.
        requireUser(state);
        if (state.pendingRip) throw GameError('Finish or cancel your open rip first.');
        var pack = D.packById[action.pack];
        if (!pack) throw GameError('That pack is not available.');
        var count = D.MULTI.indexOf(action.count) >= 0 ? action.count : 1;
        var cost = pack.price * count;
        if (state.balance < cost) {
          throw GameError('Not enough ' + D.TOKEN + '. ' + (count > 1 ? count + '× ' : '') + pack.name + ' costs $' + pack.usd * count + ' (' + cost.toLocaleString('en-US') + ' ' + D.TOKEN + ').');
        }
        if (!isHex(action.seed, 32)) throw GameError('Bad rip seed.');
        state.balance -= cost;
        state.pendingRip = { seed: action.seed, pack: pack.id, count: count, cost: cost, chain: action.chain || null, source: action.source || null, at: now };
        result.rip = state.pendingRip;
        break;
      }
      case 'ripFinish': {
        requireUser(state);
        var pr = state.pendingRip;
        if (!pr) throw GameError('There is no open rip.');
        var proof = action.proof || {};
        var randomness = String(proof.randomness || '');
        if (!(isHex(randomness, 32) || isHex(randomness, 64))) throw GameError('Bad randomness.');
        var cards = cardsFromRandomness(pr.pack, pr.count, randomness, pr.seed);
        var stored = { source: proof.source || pr.source, chain: pr.chain, seed: pr.seed, randomness: randomness, ref: proof.ref || null, tx: proof.tx || null };
        var items = cards.map(function (card, k) {
          var item = { uid: state.nextUid++, id: card.id, pack: pr.pack, at: now, proof: stored, n: k };
          state.vault.push(item);
          state.history.unshift({ id: card.id, at: now });
          return item;
        });
        state.pulls[pr.pack] = (state.pulls[pr.pack] || 0) + pr.count;
        state.totalPulls += pr.count;
        state.history = state.history.slice(0, E.historySize);
        state.pendingRip = null;
        result.items = items;
        result.spent = pr.cost;
        result.proof = stored;
        break;
      }
      case 'ripCancel': {
        // Only allowed (by the server) when no randomness was ever requested for the seed.
        requireUser(state);
        if (!state.pendingRip) throw GameError('There is no open rip.');
        state.balance += state.pendingRip.cost;
        result.refund = state.pendingRip.cost;
        state.pendingRip = null;
        break;
      }
      case 'buyback': {
        requireUser(state);
        var uids = [].concat(action.uids || action.uid || []);
        if (!uids.length) throw GameError('Choose a card to sell back.');
        var paid = 0, soldN = 0;
        uids.forEach(function (uid) {
          var idx = -1;
          for (var i = 0; i < state.vault.length; i++) if (state.vault[i].uid === uid) { idx = i; break; }
          if (idx < 0) throw GameError('That card is no longer in your vault.');
          paid += D.cardById[state.vault[idx].id].buyback;
          state.vault.splice(idx, 1);
          soldN += 1;
        });
        credit(state, paid);
        state.sold += soldN;
        result.amount = paid;
        result.sold = soldN;
        break;
      }
      case 'joinWhitelist': {
        requireUser(state);
        if (state.whitelist) throw GameError('You are already on the whitelist.');
        if (!whitelistStatus(state).eligible) throw GameError('Finish every quest to join the whitelist.');
        var spot = ctx.nextSpot ? ctx.nextSpot() : 1 + (D.hash(state.user.chain + ':' + state.user.address) % 4999);
        state.whitelist = { spot: spot, at: now };
        result.spot = spot;
        break;
      }
      case 'inviteJoined': {
        // Server: called when a new account signs up with this user's code.
        // Local demo: there is no shared backend, so the demo button calls it.
        requireUser(state);
        state.invites += 1;
        credit(state, E.inviteReward);
        result.amount = E.inviteReward;
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
    refCodeFor: refCodeFor,
    whitelistStatus: whitelistStatus,
    seriesProgress: seriesProgress,
    vaultValue: vaultValue
  };

  root.PN = root.PN || {};
  root.PN.engine = engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

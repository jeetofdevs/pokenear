/* Pokenear game engine. Pure state transitions, no DOM and no storage.
   The browser runs it locally in demo mode; the Node server runs the same
   code authoritatively when X login is configured. */
(function (root) {
  'use strict';

  var D = root.PN && root.PN.data ? root.PN.data : require('./data.js');
  var E = D.ECONOMY;

  function GameError(message) {
    var err = new Error(message);
    err.name = 'GameError';
    err.isGameError = true;
    return err;
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function normalizeHandle(raw) {
    var h = String(raw || '').trim().replace(/^@+/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    return h;
  }

  function refCodeFor(handle) {
    var code = D.hash('pokenear:' + handle.toLowerCase()).toString(36).toUpperCase();
    return ('PN' + code).slice(0, 8);
  }

  function emptyState() {
    return {
      v: 3,
      user: null,
      balance: 0,
      earned: 0,
      collection: {},
      pulls: {},
      totalPulls: 0,
      tasks: {},
      invites: 0,
      lastDaily: 0,
      whitelist: null,
      history: [],
      claimedSets: {}
    };
  }

  function credit(state, amount) {
    state.balance += amount;
    state.earned += amount;
  }

  function seriesPulls(state, seriesId) {
    if (!state.pulls[seriesId]) state.pulls[seriesId] = { packs: 0 };
    return state.pulls[seriesId];
  }

  function pickFrom(list, rng) {
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  }

  // Pick a card for one slot: roll each hit this set has (rarest first), else a base card.
  function rollSlot(series, slot, rng) {
    var hits = slot.hits || [];
    for (var i = 0; i < hits.length; i++) {
      var pool = series.byRarity[hits[i][0]];
      if (pool && rng() < 1 / hits[i][1]) return pickFrom(pool, rng);
    }
    var base = [];
    slot.base.forEach(function (r) { if (series.byRarity[r]) base = base.concat(series.byRarity[r]); });
    return pickFrom(base, rng);
  }

  // One booster pack in real pack order: commons, uncommons, reverse holos, rare slot last.
  function openPack(series, rng) {
    var out = [];
    D.PACK_SLOTS.forEach(function (slot) {
      for (var i = 0; i < slot.count; i++) {
        var card = rollSlot(series, slot, rng);
        // Reverse-holo slots print base cards in reverse foil; an IR/SIR hit is its own full-art card.
        out.push({ id: card.id, rev: !!slot.reverse && (card.tier === 'C' || card.tier === 'R') });
      }
    });
    return out;
  }

  function whitelistStatus(state) {
    var checks = {
      connect: !!state.user,
      follow: !!state.tasks.follow,
      post: !!state.tasks.post,
      invites: state.invites >= E.whitelistInvites,
      pulls: state.totalPulls >= E.whitelistPulls
    };
    var done = Object.keys(checks).filter(function (k) { return checks[k]; }).length;
    return { checks: checks, done: done, total: Object.keys(checks).length, eligible: done === Object.keys(checks).length };
  }

  function seriesProgress(state, seriesId) {
    var s = D.seriesById[seriesId];
    var owned = s.cards.filter(function (card) { return state.collection[card.id] > 0; }).length;
    return { owned: owned, total: s.cards.length, complete: owned === s.cards.length };
  }

  function collectionScore(state) {
    var score = 0;
    Object.keys(state.collection).forEach(function (id) {
      var card = D.cardById[id];
      if (card && state.collection[id] > 0) score += card.score;
    });
    return score;
  }

  function requireUser(state) {
    if (!state.user) throw GameError('Connect your X account first.');
  }

  /* apply(state, action, ctx) -> { state, result }
     ctx: { rng: () => [0,1), now: ms, mode: 'local' | 'server', nextSpot?: () => int } */
  function apply(prev, action, ctx) {
    var state = clone(prev || emptyState());
    var now = ctx.now;
    var result = {};
    switch (action && action.type) {
      case 'connect': {
        var handle = normalizeHandle(action.handle);
        if (!handle) throw GameError('Enter a valid X handle: letters, numbers or _ (max 15).');
        if (state.user) throw GameError('An X account is already connected.');
        state.user = {
          handle: handle,
          name: String(action.name || handle).slice(0, 50),
          xId: action.xId ? String(action.xId) : null,
          avatar: action.avatar ? String(action.avatar) : null,
          refCode: refCodeFor(handle),
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
      case 'pull': {
        requireUser(state);
        var series = D.seriesById[action.series];
        if (!series) throw GameError('That set is not available.');
        var product = D.productById[action.product || 'pack'];
        if (!product) throw GameError('Unknown product.');
        if (state.balance < product.price) {
          throw GameError('Not enough ' + D.TOKEN + '. ' + product.name + ' costs $' + product.usd + ' (' + product.price.toLocaleString('en-US') + ' ' + D.TOKEN + ').');
        }
        state.balance -= product.price;
        var packs = [];
        for (var k = 0; k < product.packs; k++) {
          var pack = openPack(series, ctx.rng);
          pack.forEach(function (c) {
            c.isNew = !state.collection[c.id];
            state.collection[c.id] = (state.collection[c.id] || 0) + 1;
            state.history.unshift({ id: c.id, at: now });
          });
          packs.push(pack);
        }
        seriesPulls(state, series.id).packs += product.packs;
        state.totalPulls += product.packs * D.PACK_SIZE;
        state.history = state.history.slice(0, E.historySize);
        result.packs = packs;
        result.spent = product.price;
        break;
      }
      case 'burnDupes': {
        requireUser(state);
        var gained = 0, burned = 0;
        Object.keys(state.collection).forEach(function (id) {
          var card = D.cardById[id];
          var extra = state.collection[id] - 1;
          if (!card || extra <= 0) return;
          if (action.series && card.series !== action.series) return;
          gained += extra * card.value;
          burned += extra;
          state.collection[id] = 1;
        });
        if (!burned) throw GameError('No duplicate cards to burn.');
        credit(state, gained);
        result.amount = gained;
        result.burned = burned;
        break;
      }
      case 'task': {
        requireUser(state);
        var task = D.TASKS.filter(function (t) { return t.id === action.id && !t.auto; })[0];
        if (!task) throw GameError('Unknown quest.');
        if (state.tasks[task.id]) throw GameError('Quest already completed.');
        state.tasks[task.id] = now;
        credit(state, task.reward);
        result.amount = task.reward;
        break;
      }
      case 'claimSet': {
        requireUser(state);
        if (!D.seriesById[action.series]) throw GameError('That series does not exist.');
        if (state.claimedSets[action.series]) throw GameError('Set bonus already claimed.');
        if (!seriesProgress(state, action.series).complete) throw GameError('Collect every card in the set first.');
        state.claimedSets[action.series] = now;
        credit(state, E.setBonus);
        result.amount = E.setBonus;
        break;
      }
      case 'joinWhitelist': {
        requireUser(state);
        if (state.whitelist) throw GameError('You are already on the whitelist.');
        if (!whitelistStatus(state).eligible) throw GameError('Finish every quest to join the whitelist.');
        var spot = ctx.nextSpot ? ctx.nextSpot() : 1 + (D.hash(state.user.handle.toLowerCase()) % 4999);
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
    normalizeHandle: normalizeHandle,
    openPack: openPack,
    refCodeFor: refCodeFor,
    whitelistStatus: whitelistStatus,
    seriesProgress: seriesProgress,
    collectionScore: collectionScore
  };

  root.PN = root.PN || {};
  root.PN.engine = engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

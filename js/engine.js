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
      v: 1,
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
    if (!state.pulls[seriesId]) state.pulls[seriesId] = { total: 0, sinceUR: 0 };
    return state.pulls[seriesId];
  }

  // Pick a rarity at or above `minTier`, re-weighting the remaining rates.
  function rollRarity(rng, minTier) {
    var pool = D.RARITIES.filter(function (r) { return r.tier >= minTier; });
    var total = pool.reduce(function (s, r) { return s + r.rate; }, 0);
    var x = rng() * total;
    for (var i = 0; i < pool.length; i++) {
      x -= pool[i].rate;
      if (x < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function pickCard(series, rarity, rng) {
    var list = series.byRarity[rarity.id];
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  }

  // Roll `count` cards for a series, applying pity and the 10-pull guarantee.
  function roll(state, seriesId, count, rng) {
    var series = D.seriesById[seriesId];
    var p = seriesPulls(state, seriesId);
    var UR = D.rarityById.UR.tier;
    var SR = D.rarityById.SR.tier;
    var out = [];
    var hasSRplus = false;
    for (var i = 0; i < count; i++) {
      var minTier = 0;
      var pity = false;
      if (p.sinceUR >= E.pity - 1) { minTier = UR; pity = true; }
      else if (count === 10 && i === count - 1 && !hasSRplus) { minTier = SR; }
      var rarity = rollRarity(rng, minTier);
      var card = pickCard(series, rarity, rng);
      p.total += 1;
      p.sinceUR = rarity.tier >= UR ? 0 : p.sinceUR + 1;
      if (rarity.tier >= SR) hasSRplus = true;
      out.push({ id: card.id, isNew: !state.collection[card.id], pity: pity });
      state.collection[card.id] = (state.collection[card.id] || 0) + 1;
    }
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
      if (card && state.collection[id] > 0) score += D.rarityById[card.rarity].burn * 2 + card.power;
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
        if (!D.seriesById[action.series]) throw GameError('That series does not exist.');
        var count = action.count === 10 ? 10 : 1;
        var price = count === 10 ? E.tenPrice : E.singlePrice;
        if (state.balance < price) throw GameError('Not enough ' + D.TOKEN + '. You need ' + price + '.');
        state.balance -= price;
        var cards = roll(state, action.series, count, ctx.rng);
        state.totalPulls += count;
        cards.forEach(function (c) { state.history.unshift({ id: c.id, at: now }); });
        state.history = state.history.slice(0, E.historySize);
        result.cards = cards;
        result.spent = price;
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
          gained += extra * D.rarityById[card.rarity].burn;
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
    refCodeFor: refCodeFor,
    whitelistStatus: whitelistStatus,
    seriesProgress: seriesProgress,
    collectionScore: collectionScore,
    rollRarity: rollRarity
  };

  root.PN = root.PN || {};
  root.PN.engine = engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

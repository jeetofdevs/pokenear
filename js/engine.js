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
      v: 4,
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
      history: []
    };
  }

  // Carry an account from an older save format: keep profile, balance and quests, start a fresh vault.
  function migrate(old) {
    if (!old || old.v === 4) return old;
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

  // One rip: pick a card from the pack pool by its published chance.
  function rip(pack, rng) {
    var x = rng();
    var pool = pack.pool;
    for (var i = 0; i < pool.length; i++) if (x < pool[i].cum) return D.cardById[pool[i].id];
    return D.cardById[pool[pool.length - 1].id];
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
        var pack = D.packById[action.pack];
        if (!pack) throw GameError('That pack is not available.');
        var count = D.MULTI.indexOf(action.count) >= 0 ? action.count : 1;
        var cost = pack.price * count;
        if (state.balance < cost) {
          throw GameError('Not enough ' + D.TOKEN + '. ' + (count > 1 ? count + '× ' : '') + pack.name + ' costs $' + pack.usd * count + ' (' + cost.toLocaleString('en-US') + ' ' + D.TOKEN + ').');
        }
        state.balance -= cost;
        var items = [];
        for (var k = 0; k < count; k++) {
          var card = rip(pack, ctx.rng);
          var item = { uid: state.nextUid++, id: card.id, pack: pack.id, at: now };
          state.vault.push(item);
          state.history.unshift({ id: card.id, at: now });
          items.push(item);
        }
        state.pulls[pack.id] = (state.pulls[pack.id] || 0) + count;
        state.totalPulls += count;
        state.history = state.history.slice(0, E.historySize);
        result.items = items;
        result.spent = cost;
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
    migrate: migrate,
    normalizeHandle: normalizeHandle,
    rip: rip,
    refCodeFor: refCodeFor,
    whitelistStatus: whitelistStatus,
    seriesProgress: seriesProgress,
    vaultValue: vaultValue
  };

  root.PN = root.PN || {};
  root.PN.engine = engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);

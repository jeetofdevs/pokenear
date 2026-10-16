/* Pokenear UI. Renders from store.state; all game rules live in engine.js. */
(function (root) {
  'use strict';

  var D = root.PN.data;
  var engine = root.PN.engine;
  var store = root.PN.store;
  var E = D.ECONOMY;
  var doc = root.document;

  var ROUTES = ['packs', 'binder', 'whitelist', 'ranks'];
  var ui = {
    route: 'packs',
    series: 'pocket',
    binder: 'all',
    clicked: {},          // quests whose X link was opened, awaiting confirm
    opening: null,        // { series, cards, stage, revealed: {} }
    busy: false,
    leaderboard: null
  };

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function $(sel, el) { return (el || doc).querySelector(sel); }
  function rar(id) { return D.rarityById[id]; }
  function tierOf(cardId) { return rar(D.cardById[cardId].rarity).tier; }
  function pct(r) { var v = r * 100; return (v < 1 ? v.toFixed(1) : String(+v.toFixed(1))) + '%'; }

  var X_SVG = '<svg class="x-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  var COIN = '<span class="coin" aria-hidden="true">P</span>';

  function siteBase() {
    var cfg = root.PN_CONFIG || {};
    if (cfg.siteUrl) return cfg.siteUrl.replace(/\/+$/, '') + '/';
    return root.location.origin + root.location.pathname;
  }
  function inviteLink() {
    var u = store.state.user;
    return u ? siteBase() + '?ref=' + u.refCode : siteBase();
  }
  function intentPost(text) { return 'https://x.com/intent/tweet?text=' + encodeURIComponent(text); }
  function intentFollow() { return 'https://x.com/intent/follow?screen_name=' + D.X_HANDLE; }

  function toast(msg, bad) {
    var box = $('#toasts');
    var t = doc.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.setAttribute('role', 'status');
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(function () { t.remove(); }, 3200);
  }

  function run(action, onDone) {
    if (ui.busy) return Promise.resolve();
    ui.busy = true;
    return store.dispatch(action)
      .then(function (r) { ui.busy = false; if (onDone) onDone(r); return r; })
      .catch(function (err) { ui.busy = false; toast(err.message || 'Something went wrong. Try again.', true); });
  }

  /* ---------- countdown ---------- */
  function countdownParts() {
    var ms = Math.max(0, new Date(D.SEASON_END).getTime() - Date.now());
    var s = Math.floor(ms / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
  }
  function countdownHTML() {
    var p = countdownParts();
    function seg(v, l) { return '<div class="seg"><b data-cd="' + l + '">' + String(v).padStart(2, '0') + '</b><span>' + l + '</span></div>'; }
    return '<div class="countdown" aria-label="Season 1 ends in">' + seg(p.d, 'days') + seg(p.h, 'hrs') + seg(p.m, 'min') + seg(p.s, 'sec') + '</div>';
  }
  function tickCountdown() {
    var p = countdownParts();
    var map = { days: p.d, hrs: p.h, min: p.m, sec: p.s };
    doc.querySelectorAll('[data-cd]').forEach(function (el) {
      el.textContent = String(map[el.getAttribute('data-cd')]).padStart(2, '0');
    });
  }

  /* ---------- cards ---------- */
  function cardHTML(card, opts) {
    opts = opts || {};
    var s = D.seriesById[card.series];
    var r = rar(card.rarity);
    var holo = r.tier >= rar('SR').tier;
    return '<div class="card r-' + r.id + (holo ? ' holo' : '') + '" style="--h:' + s.hue + '" title="' + esc(card.name + ' · ' + r.name) + '">' +
      (opts.isNew ? '<span class="new-tag">NEW</span>' : '') +
      (opts.count > 1 ? '<span class="count">×' + opts.count + '</span>' : '') +
      '<div class="card-inner">' +
        '<div class="card-top"><span class="card-name">' + esc(card.name) + '</span><span class="card-pow">' + card.power + '</span></div>' +
        '<div class="card-art"><span aria-hidden="true">' + card.art + '</span></div>' +
        '<div class="card-flavor">' + esc(card.flavor) + '</div>' +
        '<div class="card-foot"><span>' + s.id.slice(0, 3).toUpperCase() + ' ' + String(card.no).padStart(3, '0') + '/' + String(s.cards.length).padStart(3, '0') + '</span><span class="rbadge r-' + r.id + '" style="--rc:var(--r-' + r.id + ')">' + r.id + '</span></div>' +
      '</div><div class="foil"></div></div>';
  }
  function missingHTML(card) {
    var s = D.seriesById[card.series];
    return '<div class="card missing" title="Not collected yet"><div class="card-inner"><span class="q">?</span>' +
      '<div class="card-foot"><span>' + s.id.slice(0, 3).toUpperCase() + ' ' + String(card.no).padStart(3, '0') + '</span><span class="rbadge" style="--rc:var(--r-' + card.rarity + ')">' + card.rarity + '</span></div></div></div>';
  }
  function packArtHTML(s) {
    return '<div class="pack-art" style="--h:' + s.hue + '"><div class="pa-inner">' +
      '<div class="pa-sub">Pokenear TCG</div>' +
      '<div class="pa-emoji" aria-hidden="true">' + s.byRarity.UR[0].art + '</div>' +
      '<div class="pa-name">' + esc(s.name) + '</div>' +
      '<div class="pa-sub">Season 1 Booster</div></div></div>';
  }
  function ratesTable() {
    return '<div class="table-scroll"><table class="rates"><thead><tr><th>Rarity</th><th class="num">Drop rate</th><th class="num">Cards per set</th><th class="num">Burn value</th></tr></thead><tbody>' +
      D.RARITIES.map(function (r) {
        return '<tr><td><span class="rbadge r-' + r.id + '" style="--rc:var(--r-' + r.id + ')">' + r.id + '</span> ' + r.name + '</td>' +
          '<td class="num">' + pct(r.rate) + '</td><td class="num">' + D.SERIES[0].byRarity[r.id].length + '</td>' +
          '<td class="num">' + fmt(r.burn) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="muted" style="font-size:13px;margin-top:10px">Every 10-pack contains at least one SR or better. UR or better is guaranteed within ' + E.pity + ' pulls of each series (pity resets on any UR or Secret).</p>';
  }

  /* ---------- layout ---------- */
  function topbarHTML() {
    var st = store.state;
    var u = st.user;
    var nav = u ? '<nav class="nav" aria-label="Main">' +
      [['packs', 'Packs'], ['binder', 'Binder'], ['whitelist', 'Whitelist'], ['ranks', 'Ranks']].map(function (n) {
        return '<a href="#' + n[0] + '"' + (ui.route === n[0] ? ' aria-current="page"' : '') + '>' + n[1] + '</a>';
      }).join('') + '</nav>' : '';
    var right = u
      ? '<div class="balance" title="' + D.TOKEN + ' balance">' + COIN + '<span class="num">' + fmt(st.balance) + '</span><span class="muted" style="font-size:12px">' + D.TOKEN + '</span></div>' +
        '<div class="user-chip"><span class="avatar">' + (u.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : esc(u.handle.slice(0, 2).toUpperCase())) + '</span><span class="uh">@' + esc(u.handle) + '</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="logout">Log out</button>'
      : '<button class="btn btn-x btn-sm" data-act="connect">' + X_SVG + 'Connect X</button>';
    return '<header class="topbar"><div class="wrap">' +
      '<a class="brand" href="#packs"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">POKENEAR</span></a>' +
      (store.mode === 'local' ? '<span class="mode-pill" title="No server connected. Progress is saved in this browser only.">Demo</span>' : '') +
      nav + '<div class="top-right">' + right + '</div></div></header>';
  }

  function footerHTML() {
    return '<footer><div class="wrap"><span>' + D.TOKEN + ' rewards are off-chain points until token launch. All card names and art are original Pokenear designs.</span>' +
      '<span>Follow <a href="https://x.com/' + D.X_HANDLE + '" target="_blank" rel="noopener">@' + D.X_HANDLE + '</a></span></div></footer>';
  }

  /* ---------- landing ---------- */
  function landingHTML() {
    var fan = ['seas-11', 'pocket-12', 'shinobi-11'].map(function (id) { return cardHTML(D.cardById[id]); }).join('');
    var strip = D.SERIES.map(function (s) {
      return '<div class="pack-tile" style="--h:' + s.hue + ';cursor:default"><span class="tag">' + esc(s.tag) + '</span><span class="art" aria-hidden="true">' + s.byRarity.UR[0].art + '</span><span class="name">' + esc(s.name) + '</span><span class="meta">' + s.cards.length + ' cards</span></div>';
    }).join('');
    var refNote = store.ref ? '<p class="demo-note" style="color:var(--gold);border-color:var(--gold)">Invite code <b class="num">' + esc(store.ref) + '</b> applied. Connect X to get +' + E.referredBonus + ' ' + D.TOKEN + ' on top of the welcome bonus.</p>' : '';
    return '<section class="hero">' +
      '<div class="hero-copy">' +
        '<span class="eyebrow"><span class="live-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hot);margin-right:6px"></span>Season 1 · Whitelist open</span>' +
        '<h1>Pull cards. Climb ranks. Earn the <span class="gold">' + D.TOKEN + '</span> whitelist.</h1>' +
        '<p class="lede">Six TCG series in one binder. Connect X to claim ' + fmt(E.startBonus) + ' ' + D.TOKEN + ', rip packs, invite friends and lock your whitelist spot before Season 1 closes.</p>' +
        refNote +
        '<div class="hero-cta"><button class="btn btn-x btn-lg" data-act="connect">' + X_SVG + 'Connect with X</button><a class="btn btn-ghost btn-lg" href="#rates" data-act="scroll-rates">Drop rates</a></div>' +
        '<div><div class="eyebrow" style="margin-bottom:8px">Season 1 closes in</div>' + countdownHTML() + '</div>' +
      '</div>' +
      '<div class="fan" aria-hidden="true">' + fan + '</div>' +
    '</section>' +
    '<section class="panel"><div class="steps">' +
      step(1, 'Connect X', 'Your X account is your Pokenear profile and your invite code.') +
      step(2, 'Open packs', 'Spend ' + D.TOKEN + ' on any of six series. 10-packs guarantee SR or better.') +
      step(3, 'Invite friends', 'Each friend who joins with your link pays you ' + E.inviteReward + ' ' + D.TOKEN + '.') +
      step(4, 'Lock your spot', 'Finish every quest to claim a numbered whitelist pass.') +
    '</div></section>' +
    '<section class="view" style="gap:14px"><div class="section-head"><h2>Six series, one binder</h2><span class="muted">' + D.SERIES.length * 12 + ' cards in Season 1</span></div><div class="series-strip">' + strip + '</div></section>' +
    '<section class="panel" id="rates"><div class="section-head" style="margin-bottom:12px"><h2>Drop rates</h2><span class="muted">Same rates in every series</span></div>' + ratesTable() + '</section>';
  }
  function step(n, title, body) {
    return '<div class="step"><span class="n">' + n + '</span><h3>' + title + '</h3><p>' + body + '</p></div>';
  }

  /* ---------- packs ---------- */
  function packsHTML() {
    var st = store.state;
    var s = D.seriesById[ui.series];
    var p = st.pulls[s.id] || { total: 0, sinceUR: 0 };
    var left = E.pity - p.sinceUR;
    var prog = engine.seriesProgress(st, s.id);
    var dailyWait = st.lastDaily + E.dailyCooldownMs - Date.now();
    var picker = D.SERIES.map(function (x) {
      var pr = engine.seriesProgress(st, x.id);
      return '<button class="pack-tile" style="--h:' + x.hue + '" data-act="series" data-id="' + x.id + '" aria-pressed="' + (x.id === s.id) + '">' +
        '<span class="tag">' + esc(x.tag) + '</span><span class="art" aria-hidden="true">' + x.byRarity.UR[0].art + '</span>' +
        '<span class="name">' + esc(x.name) + '</span><span class="meta num">' + pr.owned + '/' + pr.total + ' collected</span></button>';
    }).join('');
    var chase = s.cards.filter(function (c) { return rar(c.rarity).tier >= rar('SR').tier; }).reverse();
    var recent = st.history.slice(0, 10);
    return '<section class="season"><div><div class="eyebrow"><span class="live-dot"></span>Season 1 live</div><h2>Whitelist mint closes soon</h2></div>' + countdownHTML() + '</section>' +
      '<section class="panel daily"><div><b>Daily drop</b><div class="muted" style="font-size:14px">Claim ' + E.dailyReward + ' ' + D.TOKEN + ' every ' + Math.round(E.dailyCooldownMs / 3600000) + ' hours.</div></div>' +
        (dailyWait > 0
          ? '<button class="btn" disabled>Ready in ' + Math.ceil(dailyWait / 3600000) + 'h</button>'
          : '<button class="btn btn-gold" data-act="daily">' + COIN + ' Claim ' + E.dailyReward + '</button>') + '</section>' +
      '<section class="view" style="gap:14px"><div class="section-head"><h2>Choose a series</h2></div><div class="series-picker">' + picker + '</div></section>' +
      '<section class="panel pull-stage">' + packArtHTML(s) +
        '<div class="pull-info">' +
          '<div><div class="eyebrow">' + esc(s.tag) + ' series · ' + prog.owned + '/' + prog.total + ' collected</div><h2>' + esc(s.name) + '</h2><p class="muted" style="margin-top:6px">' + esc(s.blurb) + '</p></div>' +
          '<div class="pull-buttons">' +
            '<button class="btn" data-act="pull" data-count="1"' + (st.balance < E.singlePrice ? ' disabled' : '') + '>Open 1<small>' + COIN + fmt(E.singlePrice) + '</small></button>' +
            '<button class="btn btn-gold" data-act="pull" data-count="10"' + (st.balance < E.tenPrice ? ' disabled' : '') + '>Open 10<small>' + COIN + fmt(E.tenPrice) + ' · SR+ inside</small></button>' +
          '</div>' +
          (st.balance < E.singlePrice ? '<p class="demo-note">Out of ' + D.TOKEN + '. Claim the daily drop, burn duplicates in your binder, or invite friends.</p>' : '') +
          '<div class="pity"><div style="display:flex;justify-content:space-between;font-size:14px"><span><b>Pity</b> · UR guaranteed in <b class="num">' + left + '</b> pulls</span><span class="muted num">' + p.sinceUR + '/' + E.pity + '</span></div><div class="bar"><i style="width:' + (p.sinceUR / E.pity * 100) + '%"></i></div></div>' +
          '<div><div class="eyebrow" style="margin-bottom:8px">Chase cards</div><div class="mini-cards chase">' + chase.map(function (c) { return st.collection[c.id] ? cardHTML(c) : missingHTML(c); }).join('') + '</div></div>' +
        '</div></section>' +
      (recent.length ? '<section class="view" style="gap:14px"><div class="section-head"><h2>Your latest pulls</h2><a href="#binder" class="muted">Open binder</a></div><div class="mini-cards">' +
        recent.map(function (h) { return cardHTML(D.cardById[h.id]); }).join('') + '</div></section>' : '') +
      '<section class="panel" id="rates"><div class="section-head" style="margin-bottom:12px"><h2>Drop rates</h2></div>' + ratesTable() + '</section>';
  }

  /* ---------- binder ---------- */
  function binderHTML() {
    var st = store.state;
    var totalOwned = D.SERIES.reduce(function (a, s) { return a + engine.seriesProgress(st, s.id).owned; }, 0);
    var tabs = [{ id: 'all', name: 'All', owned: totalOwned, total: D.SERIES.length * 12 }].concat(D.SERIES.map(function (s) {
      var p = engine.seriesProgress(st, s.id); return { id: s.id, name: s.name, owned: p.owned, total: p.total };
    }));
    var dupes = 0, dupeValue = 0;
    Object.keys(st.collection).forEach(function (id) {
      var c = D.cardById[id]; var extra = st.collection[id] - 1;
      if (!c || extra <= 0 || (ui.binder !== 'all' && c.series !== ui.binder)) return;
      dupes += extra; dupeValue += extra * rar(c.rarity).burn;
    });
    var list = ui.binder === 'all' ? D.SERIES : [D.seriesById[ui.binder]];
    var sections = list.map(function (s) {
      var p = engine.seriesProgress(st, s.id);
      var claim = '';
      if (st.claimedSets[s.id]) claim = '<span class="reward">Set bonus claimed</span>';
      else if (p.complete) claim = '<button class="btn btn-gold btn-sm" data-act="claimSet" data-id="' + s.id + '">' + COIN + ' Claim ' + fmt(E.setBonus) + ' set bonus</button>';
      else claim = '<span class="muted" style="font-size:13px">Complete the set for ' + fmt(E.setBonus) + ' ' + D.TOKEN + '</span>';
      return '<section class="view" style="gap:14px"><div class="binder-head"><div class="progress-line"><div style="display:flex;justify-content:space-between;gap:10px"><h2 style="font-size:24px">' + esc(s.name) + '</h2><span class="num muted">' + p.owned + '/' + p.total + '</span></div><div class="bar"><i style="width:' + (p.owned / p.total * 100) + '%"></i></div></div><div class="actions">' + claim + '</div></div>' +
        '<div class="binder-grid">' + s.cards.map(function (c) { return st.collection[c.id] ? cardHTML(c, { count: st.collection[c.id] }) : missingHTML(c); }).join('') + '</div></section>';
    }).join('');
    return '<section class="section-head"><div><div class="eyebrow">Your collection</div><h2 style="font-size:36px">Binder</h2></div>' +
      '<button class="btn" data-act="burn"' + (dupes ? '' : ' disabled') + '>Burn ' + dupes + ' duplicates for ' + COIN + fmt(dupeValue) + '</button></section>' +
      '<div class="binder-tabs" role="group" aria-label="Filter by series">' + tabs.map(function (t) {
        return '<button class="chip-btn" data-act="binder" data-id="' + t.id + '" aria-pressed="' + (ui.binder === t.id) + '">' + esc(t.name) + '<span class="num">' + t.owned + '/' + t.total + '</span></button>';
      }).join('') + '</div>' + sections;
  }

  /* ---------- whitelist ---------- */
  function whitelistHTML() {
    var st = store.state;
    var wl = engine.whitelistStatus(st);
    var link = inviteLink();
    var postText = 'I\'m collecting cards on @' + D.X_HANDLE + ' and farming ' + D.TOKEN + ' for the Season 1 whitelist. Six TCG series, pity system, 10-packs with guaranteed SR. Join with my link and get +' + E.referredBonus + ' bonus: ' + link;
    function quest(id, title, sub, action, reward) {
      var done = wl.checks[id];
      return '<li class="quest' + (done ? ' done' : '') + '"><span class="tick" aria-hidden="true">✓</span><div><div class="q-title">' + title + '</div><div class="q-sub">' + sub + '</div></div><div class="q-act">' +
        (reward ? '<span class="reward">' + COIN + '+' + reward + '</span>' : '') + (done ? '<span style="color:var(--ok);font-weight:700">Done</span>' : action) + '</div></li>';
    }
    var followAct = ui.clicked.follow
      ? '<button class="btn btn-gold btn-sm" data-act="task" data-id="follow">I followed</button>'
      : '<a class="btn btn-x btn-sm" href="' + intentFollow() + '" target="_blank" rel="noopener" data-act="xlink" data-id="follow">' + X_SVG + 'Follow</a>';
    var postAct = ui.clicked.post
      ? '<button class="btn btn-gold btn-sm" data-act="task" data-id="post">I posted</button>'
      : '<a class="btn btn-x btn-sm" href="' + intentPost(postText) + '" target="_blank" rel="noopener" data-act="xlink" data-id="post">' + X_SVG + 'Post</a>';
    var inviteAct = store.mode === 'local'
      ? '<button class="btn btn-sm" data-act="demoInvite" title="Demo only: no server is tracking real sign-ups">Simulate a friend joining</button>'
      : '<button class="btn btn-sm" data-act="copy">Copy link</button>';
    var pullsAct = '<a class="btn btn-sm" href="#packs">Open packs</a>';

    var pass = st.whitelist
      ? '<div class="wl-pass"><div class="eyebrow" style="color:inherit">Season 1 Whitelist Pass</div><h3>You are on the list</h3><div class="spot">#' + String(st.whitelist.spot).padStart(4, '0') + '</div><div>@' + esc(st.user.handle) + ' · ' + fmt(st.earned) + ' ' + D.TOKEN + ' earned</div>' +
        '<div><a class="btn btn-x" href="' + intentPost('I just locked whitelist spot #' + String(st.whitelist.spot).padStart(4, '0') + ' for ' + D.TOKEN + ' on @' + D.X_HANDLE + '. Get yours before Season 1 closes: ' + link) + '" target="_blank" rel="noopener">' + X_SVG + 'Share my pass</a></div></div>'
      : '<div class="panel" style="display:grid;gap:12px"><b>Claim your whitelist pass</b><p class="muted" style="font-size:14px">Finish all ' + wl.total + ' quests to get a numbered pass for the ' + D.TOKEN + ' launch.</p>' +
        '<button class="btn btn-gold btn-lg" data-act="joinWhitelist"' + (wl.eligible ? '' : ' disabled') + '>' + (wl.eligible ? 'Join the whitelist' : (wl.total - wl.done) + ' quests left') + '</button></div>';

    return '<section class="section-head"><div><div class="eyebrow">Season 1</div><h2 style="font-size:36px">Whitelist</h2></div>' + countdownHTML() + '</section>' +
      '<div class="wl-grid">' +
        '<section class="panel" style="display:grid;gap:18px">' +
          '<div class="wl-status"><div class="ring" style="--p:' + Math.round(wl.done / wl.total * 100) + '"><div><b class="num">' + wl.done + '/' + wl.total + '</b><small>quests</small></div></div>' +
            '<div><h3 style="font-size:24px">' + (st.whitelist ? 'Whitelisted' : wl.eligible ? 'Ready to join' : 'Not whitelisted yet') + '</h3><p class="muted" style="font-size:14px;margin-top:4px">Quest rewards are paid in ' + D.TOKEN + ' the moment you complete them.</p></div></div>' +
          '<ul class="quests">' +
            quest('connect', 'Connect your X account', 'Connected as @' + esc(st.user.handle), '', 0) +
            quest('follow', 'Follow @' + D.X_HANDLE + ' on X', 'Opens X in a new tab, then confirm here.', followAct, 100) +
            quest('post', 'Post your invite link on X', 'Shares a ready-made post with your code.', postAct, 150) +
            quest('invites', 'Invite ' + E.whitelistInvites + ' friends', '<span class="num">' + Math.min(st.invites, E.whitelistInvites) + '/' + E.whitelistInvites + '</span> joined · +' + E.inviteReward + ' per friend', inviteAct, 0) +
            quest('pulls', 'Open ' + E.whitelistPulls + ' cards', '<span class="num">' + Math.min(st.totalPulls, E.whitelistPulls) + '/' + E.whitelistPulls + '</span> opened in any series', pullsAct, 0) +
          '</ul>' +
          (store.mode === 'local' ? '<p class="demo-note">Demo mode: X follows and posts are self-confirmed, and invites are simulated because there is no server tracking sign-ups. Run the Pokenear server with X API keys for real login and referral tracking.</p>' : '') +
        '</section>' +
        '<div style="display:grid;gap:24px">' + pass +
          '<section class="panel" style="display:grid;gap:14px"><div><b>Invite friends</b><p class="muted" style="font-size:14px">Friends get +' + E.referredBonus + ' ' + D.TOKEN + ' on sign-up. You get ' + E.inviteReward + ' for each one.</p></div>' +
            '<div class="ref-box"><input id="ref-link" readonly value="' + esc(link) + '" aria-label="Your invite link"><button class="btn" data-act="copy">Copy</button></div>' +
            '<a class="btn btn-x" href="' + intentPost(postText) + '" target="_blank" rel="noopener">' + X_SVG + 'Share invite on X</a>' +
            '<div class="stats-row"><div class="stat"><b>' + st.invites + '</b><span>Friends joined</span></div><div class="stat"><b>' + fmt(st.invites * E.inviteReward) + '</b><span>' + D.TOKEN + ' from invites</span></div><div class="stat"><b class="num">' + esc(st.user.refCode) + '</b><span>Your code</span></div></div>' +
          '</section>' +
        '</div>' +
      '</div>';
  }

  /* ---------- leaderboard ---------- */
  var SAMPLE = [
    ['Holo Hunter', 'holo_hunter', 9420, 61, true], ['Pack Ripper', 'packripper', 8130, 57, true], ['Secret Seeker', 'secretseeker', 6900, 52, true],
    ['Binder Queen', 'binderqueen', 5480, 46, true], ['Pity Breaker', 'pitybreaker', 4210, 39, false], ['Near Trainer', 'neartrainer', 3020, 31, false],
    ['Foil Fanatic', 'foilfanatic', 2150, 24, false], ['Daily Grinder', 'dailygrinder', 1240, 17, false]
  ];
  function ranksHTML() {
    var st = store.state;
    var meOwned = Object.keys(st.collection).filter(function (k) { return st.collection[k] > 0; }).length;
    var me = { name: st.user.name, handle: st.user.handle, score: engine.collectionScore(st), cards: meOwned, wl: !!st.whitelist, me: true };
    var rows, isSample = false;
    if (ui.leaderboard) {
      rows = ui.leaderboard.map(function (r) { return { name: r.name, handle: r.handle, score: r.score, cards: r.cards, wl: r.wl, me: r.handle === st.user.handle }; });
    } else {
      isSample = true;
      rows = SAMPLE.map(function (r) { return { name: r[0], handle: r[1], score: r[2], cards: r[3], wl: r[4], sample: true }; }).concat([me]);
    }
    rows.sort(function (a, b) { return b.score - a.score; });
    return '<section class="section-head"><div><div class="eyebrow">Collection score</div><h2 style="font-size:36px">Ranks</h2></div><span class="muted" style="font-size:14px">Score = card power + 2× burn value for every unique card you own</span></section>' +
      (isSample ? '<p class="demo-note">Demo mode: rows marked Sample are placeholders. With the server running, this table lists real collectors.</p>' : '') +
      '<section class="panel table-scroll" style="padding:8px 12px"><table class="lb"><thead><tr><th>#</th><th>Collector</th><th class="num">Unique cards</th><th class="num">Score</th><th>Whitelist</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr' + (r.me ? ' class="me"' : '') + '><td class="rank">' + (i + 1) + '</td><td><div class="who"><span class="avatar">' + esc(r.handle.slice(0, 2).toUpperCase()) + '</span><div><b>' + esc(r.name) + (r.me ? ' (you)' : '') + '</b><div class="muted" style="font-size:13px">@' + esc(r.handle) + (r.sample ? ' <span class="sample">Sample</span>' : '') + '</div></div></div></td>' +
          '<td class="num">' + r.cards + '</td><td class="num"><b>' + fmt(r.score) + '</b></td><td>' + (r.wl ? '<span style="color:var(--ok);font-weight:700">Whitelisted</span>' : '<span class="muted">Not yet</span>') + '</td></tr>';
      }).join('') + '</tbody></table></section>';
  }

  /* ---------- main render ---------- */
  function render() {
    var st = store.state;
    var body;
    if (!st.user) body = landingHTML();
    else if (ui.route === 'binder') body = binderHTML();
    else if (ui.route === 'whitelist') body = whitelistHTML();
    else if (ui.route === 'ranks') body = ranksHTML();
    else body = packsHTML();
    $('#app').innerHTML = topbarHTML() + '<main><div class="wrap view">' + body + '</div></main>' + footerHTML();
  }

  function setRoute() {
    var h = (root.location.hash || '').replace('#', '');
    ui.route = ROUTES.indexOf(h) >= 0 ? h : (ui.route || 'packs');
    if (ui.route === 'ranks' && store.mode === 'live') {
      store.leaderboard().then(function (rows) { ui.leaderboard = rows; render(); }).catch(function () { ui.leaderboard = null; });
    }
    render();
    root.scrollTo(0, 0);
  }

  /* ---------- connect modal ---------- */
  function openConnect() {
    if (store.mode === 'live') { store.connectX(); return; }
    var host = $('#modal');
    host.innerHTML = '<div class="modal-back" data-act="close-modal"><form class="modal" id="connect-form" role="dialog" aria-modal="true" aria-labelledby="connect-title">' +
      '<div style="display:flex;align-items:center;gap:10px">' + X_SVG.replace('x-logo', 'x-logo" style="width:22px;height:22px') + '<h2 id="connect-title">Connect X</h2></div>' +
      '<p class="muted" style="font-size:14px">This preview runs without X API keys, so type your handle to continue. With the Pokenear server configured, this button opens the real X sign-in page.</p>' +
      '<div class="field"><label for="x-handle">X handle</label><div class="input-at"><span>@</span><input id="x-handle" name="handle" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16" placeholder="yourname" required></div><div class="err" id="connect-err"></div></div>' +
      (store.ref ? '<p class="reward">' + COIN + 'Invite code ' + esc(store.ref) + ' gives +' + E.referredBonus + ' bonus</p>' : '') +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-x">' + X_SVG + 'Connect</button></div>' +
      '</form></div>';
    $('#x-handle').focus();
  }
  function closeModal() { $('#modal').innerHTML = ''; }

  /* ---------- pack opening ---------- */
  function startOpening(count) {
    if (ui.busy) return;
    var seriesId = ui.series;
    run({ type: 'pull', series: seriesId, count: count }, function (result) {
      if (!result || !result.cards) return;
      ui.opening = { series: seriesId, cards: result.cards, stage: 'pack', revealed: {}, count: count };
      renderOverlay();
    });
  }

  function renderOverlay() {
    var o = ui.opening;
    var host = $('#overlay');
    if (!o) { host.innerHTML = ''; doc.body.style.overflow = ''; return; }
    doc.body.style.overflow = 'hidden';
    var s = D.seriesById[o.series];
    var html;
    if (o.stage === 'pack') {
      html = '<div class="open-stage"><div class="eyebrow">' + esc(s.name) + ' · ' + o.cards.length + ' card' + (o.cards.length > 1 ? 's' : '') + '</div>' +
        '<button class="big-pack" data-act="tear" aria-label="Tear open the pack">' + packArtHTML(s) + '</button>' +
        '<h2>Tap the pack to tear it open</h2></div>';
    } else {
      var all = o.cards.every(function (c, i) { return o.revealed[i]; });
      var grid = o.cards.map(function (c, i) {
        var card = D.cardById[c.id];
        var t = rar(card.rarity);
        var hint = t.tier >= rar('SR').tier ? ' hint-' + t.id : '';
        return '<button class="flip' + hint + (o.revealed[i] ? ' revealed' : '') + '" data-act="flip" data-i="' + i + '" style="animation-delay:' + (i * 60) + 'ms" aria-label="' + (o.revealed[i] ? esc(card.name + ', ' + t.name) : 'Reveal card ' + (i + 1)) + '">' +
          '<div class="flip-inner"><div class="face back"><div class="card-back"><span class="brand-mark"></span></div></div><div class="face front">' + cardHTML(card, { isNew: c.isNew }) + '</div></div></button>';
      }).join('');
      var summary = '';
      var actions;
      if (all) {
        var best = o.cards.slice().sort(function (a, b) { return tierOf(b.id) - tierOf(a.id); })[0];
        var bestCard = D.cardById[best.id];
        var news = o.cards.filter(function (c) { return c.isNew; }).length;
        var shareText = 'Just pulled ' + bestCard.name + ' [' + bestCard.rarity + '] from ' + s.name + ' on @' + D.X_HANDLE + '. Farming ' + D.TOKEN + ' for the whitelist, join me: ' + inviteLink();
        summary = '<div class="summary"><span>Best pull <b>' + esc(bestCard.name) + '</b> <span class="rbadge r-' + bestCard.rarity + '" style="--rc:var(--r-' + bestCard.rarity + ')">' + bestCard.rarity + '</span></span><span><b>' + news + '</b> new for your binder</span></div>';
        var price = o.count === 10 ? E.tenPrice : E.singlePrice;
        actions = '<a class="btn btn-x" href="' + intentPost(shareText) + '" target="_blank" rel="noopener">' + X_SVG + 'Share pull</a>' +
          '<button class="btn btn-gold" data-act="again"' + (store.state.balance < price ? ' disabled' : '') + '>Open ' + o.count + ' more · ' + fmt(price) + '</button>' +
          '<button class="btn" data-act="close-open">Done</button>';
      } else {
        actions = '<button class="btn btn-gold" data-act="reveal-all">Reveal all</button>';
      }
      html = '<div class="open-stage"><div class="eyebrow">' + esc(s.name) + '</div><h2>' + (all ? 'Pack opened' : 'Tap each card to flip') + '</h2>' +
        '<div class="reveal-grid' + (o.cards.length === 1 ? ' single' : '') + '">' + grid + '</div>' + summary + '<div class="open-actions">' + actions + '</div></div>';
    }
    host.innerHTML = '<div class="overlay" role="dialog" aria-modal="true" aria-label="Pack opening">' + html + '</div><div class="flash" id="flash"></div>';
  }

  function flip(i) {
    var o = ui.opening;
    if (!o || o.revealed[i]) return;
    o.revealed[i] = true;
    var btn = doc.querySelector('.flip[data-i="' + i + '"]');
    if (btn) btn.classList.add('revealed');
    var card = D.cardById[o.cards[i].id];
    if (rar(card.rarity).tier >= rar('UR').tier) flash(card.rarity === 'SEC' ? 'var(--r-SEC)' : 'var(--r-UR)');
    if (o.cards.every(function (c, k) { return o.revealed[k]; })) setTimeout(renderOverlay, 600);
  }
  function flash(color) {
    var f = $('#flash');
    if (!f) return;
    f.style.background = 'radial-gradient(circle, ' + color + ', transparent 70%)';
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }
  function revealAll() {
    var o = ui.opening;
    o.cards.forEach(function (c, i) { if (!o.revealed[i]) setTimeout(function () { flip(i); }, i * 110); });
  }
  function closeOpening() { ui.opening = null; renderOverlay(); render(); }

  /* ---------- events ---------- */
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    switch (act) {
      case 'connect': openConnect(); break;
      case 'close-modal': if (e.target === el) closeModal(); break;
      case 'logout': store.logout().then(function () { ui.clicked = {}; toast('Logged out.'); }); break;
      case 'scroll-rates': e.preventDefault(); var r = $('#rates'); if (r) r.scrollIntoView({ behavior: 'smooth' }); break;
      case 'series': ui.series = id; render(); break;
      case 'pull': startOpening(Number(el.getAttribute('data-count'))); break;
      case 'daily': run({ type: 'daily' }, function (r) { toast('+' + r.amount + ' ' + D.TOKEN + ' claimed.'); }); break;
      case 'binder': ui.binder = id; render(); break;
      case 'burn': run({ type: 'burnDupes', series: ui.binder === 'all' ? null : ui.binder }, function (r) { toast('Burned ' + r.burned + ' cards for ' + fmt(r.amount) + ' ' + D.TOKEN + '.'); }); break;
      case 'claimSet': run({ type: 'claimSet', series: id }, function (r) { toast('Set complete! +' + fmt(r.amount) + ' ' + D.TOKEN + '.'); }); break;
      case 'xlink': ui.clicked[id] = true; setTimeout(render, 300); break;
      case 'task': run({ type: 'task', id: id }, function (r) { toast('Quest complete. +' + r.amount + ' ' + D.TOKEN + '.'); }); break;
      case 'demoInvite': run({ type: 'inviteJoined' }, function (r) { toast('A friend joined. +' + r.amount + ' ' + D.TOKEN + '.'); }); break;
      case 'joinWhitelist': run({ type: 'joinWhitelist' }, function (r) { toast('Whitelisted! Your spot is #' + r.spot + '.'); }); break;
      case 'copy': copyLink(); break;
      case 'tear':
        el.classList.add('tearing');
        el.disabled = true;
        setTimeout(function () { if (ui.opening) { ui.opening.stage = 'cards'; renderOverlay(); } }, 620);
        break;
      case 'flip': flip(Number(el.getAttribute('data-i'))); break;
      case 'reveal-all': revealAll(); break;
      case 'again': var c = ui.opening.count; ui.opening = null; renderOverlay(); startOpening(c); break;
      case 'close-open': closeOpening(); break;
    }
  }

  function copyLink() {
    var link = inviteLink();
    var input = $('#ref-link');
    function fallback() {
      if (input) { input.focus(); input.select(); }
      toast('Link selected. Press Ctrl+C or Cmd+C to copy.');
    }
    try {
      navigator.clipboard.writeText(link).then(function () { toast('Invite link copied.'); }, fallback);
    } catch (err) { fallback(); }
  }

  function onSubmit(e) {
    if (e.target.id !== 'connect-form') return;
    e.preventDefault();
    var input = $('#x-handle');
    var handle = engine.normalizeHandle(input.value);
    if (!handle) { $('#connect-err').textContent = 'Use 1–15 letters, numbers or underscores.'; input.focus(); return; }
    store.connectX(handle).then(function (r) {
      closeModal();
      root.location.hash = 'packs';
      setRoute();
      toast('Welcome @' + handle + '! +' + fmt(r.bonus) + ' ' + D.TOKEN + ' added.');
    }).catch(function (err) { $('#connect-err').textContent = err.message; });
  }

  // Holographic tilt for SR and above.
  var tilted = null;
  function onMove(e) {
    var card = e.target.closest && e.target.closest('.card.holo');
    if (tilted && tilted !== card) resetTilt();
    if (!card || e.pointerType === 'touch') return;
    var b = card.getBoundingClientRect();
    var x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    card.style.setProperty('--mx', (x * 100) + '%');
    card.style.setProperty('--my', (y * 100) + '%');
    card.style.setProperty('--ry', ((x - 0.5) * 18) + 'deg');
    card.style.setProperty('--rx', ((0.5 - y) * 18) + 'deg');
    tilted = card;
  }
  function resetTilt() {
    if (!tilted) return;
    ['--mx', '--my', '--rx', '--ry'].forEach(function (p) { tilted.style.removeProperty(p); });
    tilted = null;
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if ($('#modal').innerHTML) closeModal();
    else if (ui.opening && ui.opening.stage === 'cards') {
      if (ui.opening.cards.every(function (c, i) { return ui.opening.revealed[i]; })) closeOpening(); else revealAll();
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    var app = $('#app');
    ['overlay', 'modal', 'toasts'].forEach(function (id) {
      if (!$('#' + id)) { var d = doc.createElement('div'); d.id = id; if (id === 'toasts') d.className = 'toasts'; doc.body.appendChild(d); }
    });
    app.innerHTML = '<div class="wrap" style="padding-block:80px;text-align:center" class="muted">Loading Pokenear…</div>';
    doc.addEventListener('click', onClick);
    doc.addEventListener('submit', onSubmit);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('keydown', onKey);
    root.addEventListener('hashchange', setRoute);
    store.subscribe(function () { if (!ui.opening || ui.opening.stage !== 'cards') render(); });
    store.init().then(function () {
      if (store.mode === 'live' && /[?&]x_error=/.test(root.location.search)) toast('X sign-in did not finish. Try again.', true);
      setRoute();
      setInterval(tickCountdown, 1000);
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

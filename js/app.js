/* Pokenear UI. Renders from store.state; all game rules live in engine.js.
   Gacha model: tiered packs, one card per rip, published odds, instant 90% buyback.
   Cards are drawn from real set data (js/cards.js). When remote images are allowed,
   the official card scan fades in over the drawn card. */
(function (root) {
  'use strict';

  var D = root.PN.data;
  var engine = root.PN.engine;
  var store = root.PN.store;
  var E = D.ECONOMY;
  var doc = root.document;
  var CFG = root.PN_CONFIG || {};

  var ROUTES = ['packs', 'vault', 'whitelist', 'ranks'];
  var ui = {
    route: 'packs',
    pack: D.PACKS[0].id,
    vaultSort: 'value',
    showAllOdds: false,
    clicked: {},          // quests whose X link was opened, awaiting confirm
    opening: null,        // { pack, items, stage, revealed: {}, count, sold: {} }
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
  function rar(id) { return D.tierById[id]; }
  function rankOf(cardId) { return rar(D.cardById[cardId].tier).rank; }
  function pct(r) { var v = r * 100; return (v < 1 ? v.toFixed(1) : String(+v.toFixed(1))) + '%'; }
  function usd(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function tokenUsd(amount) { return usd(amount * D.TOKEN_USD); }
  function seriesOf(card) { return D.seriesById[card.series]; }

  var X_SVG = '<svg class="x-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  var COIN = '<span class="coin" aria-hidden="true">P</span>';

  function siteBase() {
    if (CFG.siteUrl) return CFG.siteUrl.replace(/\/+$/, '') + '/';
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

  /* ---------- energy & colour tables ---------- */
  var ENERGY = {
    Grass: ['#4f9d3a', 'M5 19C5 9 11 4 20 4c0 9-5 15-15 15zm1.5-1.5L15 10'],
    Fire: ['#e2462a', 'M12 2c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-5 1-8z'],
    Water: ['#2f86d1', 'M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13z'],
    Lightning: ['#f0bd1f', 'M13 2 4 14h7l-2 8 9-12h-7l2-8z', true],
    Psychic: ['#8e4fbf', 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    Fighting: ['#b8622b', 'M7 9h10v6a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4zm0 0V6h2.5v3m0 0V5H12v4m0 0V5h2.5v4m0 0V6H17v3'],
    Darkness: ['#2c3644', 'M15 3a9 9 0 1 0 6 15A8 8 0 0 1 15 3z'],
    Metal: ['#8a95a3', 'M12 3l8 5v8l-8 5-8-5V8z'],
    Dragon: ['#a8913a', 'M4 20 12 3l8 17-8-4z'],
    Colorless: ['#e2e0d4', 'M12 3l2.6 6 6.4.6-4.9 4.3 1.5 6.3L12 17l-5.6 3.2 1.5-6.3L3 9.6 9.4 9z', true],
    Fairy: ['#d978ad', 'M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z'],
    Trainer: ['#6b7b93', 'M12 3l2.6 6 6.4.6-4.9 4.3 1.5 6.3L12 17l-5.6 3.2 1.5-6.3L3 9.6 9.4 9z']
  };
  // Art-window and full-art backdrops per type: [light, deep]
  var TYPE_BG = {
    Grass: ['#cfe8a8', '#3f8a3a'], Fire: ['#ffd0a0', '#c4361f'], Water: ['#bfe0f6', '#2465a8'], Lightning: ['#fff1a6', '#d39b12'],
    Psychic: ['#e8c9f2', '#7a3aa5'], Fighting: ['#efc9a3', '#8f4a1f'], Darkness: ['#9aa6b8', '#1d2533'], Metal: ['#dfe4ea', '#6d7886'],
    Dragon: ['#efe0a0', '#7d6a1f'], Colorless: ['#f2f1ea', '#9c9a8e'], Fairy: ['#f8d3e6', '#b9558c'], Trainer: ['#dde5ee', '#51627c']
  };
  // Card frame tint behind the text (lighter version of the type colour)
  var TYPE_FRAME = {
    Grass: '#e6f1cf', Fire: '#f8dcc7', Water: '#d5e8f5', Lightning: '#f8efc0', Psychic: '#ecdcf2', Fighting: '#efd9c4',
    Darkness: '#c9cfd9', Metal: '#e4e7eb', Dragon: '#efe7c4', Colorless: '#f1f0ea', Fairy: '#f6dfeb', Trainer: '#e6ebf1'
  };

  function energyIcon(type, extra) {
    var e = ENERGY[type] || ENERGY.Colorless;
    return '<span class="ico' + (e[2] ? ' dark' : '') + (extra ? ' ' + extra : '') + '" style="--ec:' + e[0] + '" title="' + esc(type) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + e[1] + '"/></svg></span>';
  }
  function artUrl(dex) { return 'assets/art/' + dex + '.webp'; }
  function realImg(card) {
    if (CFG.remoteImages === false || !card.img) return '';
    return '<img class="real" src="' + esc(card.img) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  }

  /* ---------- cards ---------- */
  var FULL_ART = { UR: 1, IR: 1, SIR: 1, HR: 1, BWR: 1, MUR: 1 };
  function pokemonCardHTML(card) {
    var s = seriesOf(card);
    var type = card.type || 'Colorless';
    var bg = TYPE_BG[type] || TYPE_BG.Colorless;
    var isPk = card.cat === 'Pokemon';
    var full = FULL_ART[card.code];
    var gold = card.code === 'HR' || card.code === 'MUR';
    var cls = 'pk' + (full ? ' full' : '') + (gold ? ' gold' : '') + (card.cat === 'Trainer' ? ' trainer' : '') + (card.cat === 'Energy' ? ' energy' : '');
    var style = '--tb:' + (TYPE_FRAME[type] || '#eee') + ';--ab:linear-gradient(160deg,' + bg[0] + ',' + bg[1] + ')';
    var head, art, body;
    if (isPk) {
      head = '<div class="pk-head"><span class="stage">' + esc(card.stage.replace('Stage', 'Stage ')) + '</span><span class="nm">' + esc(card.name) + '</span>' +
        '<span class="hp"><small>HP</small>' + card.hp + energyIcon(type) + '</span></div>';
      art = '<div class="art">' + (card.dex ? '<img src="' + artUrl(card.dex) + '" alt="" loading="lazy" decoding="async">' : energyIcon(type, 'ph-ico') + '<span class="ph">' + esc(card.name.replace(/ ex$/, '')) + '</span>') + '</div>';
      var moves = (card.ab ? '<div class="ability"><b>Ability</b>' + esc(card.ab) + '</div>' : '') +
        card.atk.map(function (a) {
          var cost = '';
          for (var i = 0; i < Math.min(a.c, 4); i++) cost += energyIcon(i === 0 ? type : 'Colorless');
          return '<div class="move"><span class="cost">' + cost + '</span><span class="mn">' + esc(a.n) + '</span><span class="dmg">' + esc(a.d) + '</span></div>';
        }).join('');
      body = (full ? '<div class="head-spacer"></div>' : '<div class="meta">' + (card.dex ? 'NO. ' + String(card.dex).padStart(4, '0') + ' · ' : '') + esc(card.stage.replace('Stage', 'Stage ')) + ' Pokémon</div>') +
        '<div class="moves">' + moves + '</div>' +
        '<div class="foot"><span class="wk">' + (card.weak ? 'weakness ' + energyIcon(card.weak) + '×2' : '') + '</span><span>retreat ' + card.ret + '</span>' +
        '<span class="setno">' + esc(s.short) + ' ' + esc(card.no) + '<span class="rc">' + esc(card.code) + '</span></span></div>';
    } else if (card.cat === 'Energy') {
      head = '<div class="pk-head"><span class="nm">' + esc(card.name) + '</span></div>';
      art = '<div class="art">' + energyIcon(type, 'big-ico') + '</div>';
      body = '<div class="moves"></div><div class="foot"><span>Basic Energy</span><span class="setno">' + esc(s.short) + ' ' + esc(card.no) + '<span class="rc">' + esc(card.code) + '</span></span></div>';
    } else {
      head = '<div class="pk-head"><span class="tt">Trainer · ' + esc(card.sub) + '</span></div><div class="pk-head" style="margin-top:2%"><span class="nm">' + esc(card.name) + '</span></div>';
      art = '<div class="art"><span class="ph">' + esc(card.sub || 'Trainer') + '</span></div>';
      body = '<div class="moves"><div class="fx">' + esc(card.fx) + '</div></div>' +
        '<div class="foot"><span>' + esc(card.sub) + '</span><span class="setno">' + esc(s.short) + ' ' + esc(card.no) + '<span class="rc">' + esc(card.code) + '</span></span></div>';
    }
    return '<div class="' + cls + '" style="' + style + '" ><div class="pk-in">' + head + art + body +
      (card.illus ? '<div class="illus">Illus. ' + esc(card.illus) + '</div>' : '') + '</div></div>';
  }

  function cardHTML(card, opts) {
    opts = opts || {};
    var t = rar(card.tier);
    var holo = t.rank >= rar('SR').rank;
    var face = pokemonCardHTML(card);
    var cls = 'card t-' + t.id + (holo ? ' holo' : '') + (opts.rev ? ' rev' : '') + ' ';
    // Inject badges, official scan and foil before the outer closing tag.
    var extras = (opts.isNew ? '<span class="new-tag">NEW</span>' : '') +
      (opts.count > 1 ? '<span class="count">×' + opts.count + '</span>' : '') +
      (opts.rev ? '<span class="rev-tag">Reverse Holo</span>' : '') +
      realImg(card) + '<div class="foil"></div>';
    return face.replace(/^<div class="/, '<div class="' + cls).slice(0, -6) + extras + '</div>';
  }

  // Booster wrapper look per pack tier: foil colours, hero Pokémon and two companions behind it.
  var PACK_LOOK = {
    starter: { hero: 25, side: [1, 7], foil: ['#ffe14d', '#f7a51c', '#c4560f'], ink: '#3a1d00', stars: 1, label: 'Starter' },
    rare: { hero: 94, side: [92, 93], foil: ['#c7a2ff', '#7a3fe0', '#2a1263'], ink: '#ffffff', stars: 2, label: 'Rare' },
    elite: { hero: 448, side: [282, 359], foil: ['#8fe9ff', '#2a8fe0', '#0d2f73'], ink: '#ffffff', stars: 3, label: 'Elite' },
    legend: { hero: 6, side: [150, 151], foil: ['#ffcf6b', '#c0262d', '#1c0306'], ink: '#ffe8a8', stars: 4, label: 'Legend' }
  };
  // Zig-zag crimp along the top and bottom of the wrapper.
  var CRIMP = (function () {
    var pts = [], teeth = 24, depth = 2.2;
    for (var i = 0; i <= teeth; i++) pts.push((i * 100 / teeth).toFixed(2) + '% ' + (i % 2 ? depth : 0) + '%');
    for (var j = teeth; j >= 0; j--) pts.push((j * 100 / teeth).toFixed(2) + '% ' + (100 - (j % 2 ? depth : 0)) + '%');
    return 'polygon(' + pts.join(',') + ')';
  })();

  function packArtHTML(p) {
    var look = PACK_LOOK[p.id] || PACK_LOOK.starter;
    var stars = '';
    for (var i = 0; i < 4; i++) stars += '<i class="' + (i < look.stars ? 'on' : '') + '">★</i>';
    return '<div class="booster" style="--f1:' + look.foil[0] + ';--f2:' + look.foil[1] + ';--f3:' + look.foil[2] + ';--ink:' + look.ink + '">' +
      '<div class="bw" style="clip-path:' + CRIMP + '">' +
        '<div class="bw-rays"></div><div class="bw-holo"></div>' +
        '<div class="bw-crimp top"></div><div class="bw-crimp bottom"></div>' +
        '<div class="bw-tear">TEAR ▸</div>' +
        '<div class="bw-logo"><span>POKENEAR</span><small>Trading Card Gacha</small></div>' +
        '<div class="bw-stage">' +
          '<span class="bw-ring"></span>' +
          '<img class="bw-side l" src="' + artUrl(look.side[0]) + '" alt="" decoding="async">' +
          '<img class="bw-side r" src="' + artUrl(look.side[1]) + '" alt="" decoding="async">' +
          '<img class="bw-hero" src="' + artUrl(look.hero) + '" alt="" decoding="async">' +
        '</div>' +
        '<div class="bw-ribbon"><span>' + esc(look.label) + ' Pack</span></div>' +
        '<div class="bw-stars">' + stars + '</div>' +
        '<div class="bw-foot">1 CARD · EV ' + usd(p.ev) + '</div>' +
        '<div class="bw-sheen"></div>' +
      '</div>' +
      '<div class="bw-price"><b>' + usd(p.usd) + '</b></div>' +
    '</div>';
  }

  function chanceOf(p, cardId) {
    var e = p.pool.filter(function (x) { return x.id === cardId; })[0];
    return e ? e.p : 0;
  }
  function fmtChance(x) {
    if (x >= 0.1) return (x * 100).toFixed(1) + '%';
    if (x >= 0.01) return (x * 100).toFixed(2) + '%';
    return (x * 100).toFixed(3) + '%';
  }
  function oneIn(x) { return x > 0 ? '1 in ' + fmt(1 / x) : '-'; }

  function packStatsHTML(p) {
    return '<div class="stat-chips">' +
      '<span class="schip"><small>Expected value</small><b>' + usd(p.ev) + '</b></span>' +
      '<span class="schip"><small>Instant buyback</small><b>' + Math.round(D.BUYBACK_RATE * 100) + '%</b></span>' +
      '<span class="schip"><small>Pull ≥ ' + usd(p.usd) + '</small><b>' + fmtChance(p.beat) + '</b></span>' +
      '<span class="schip"><small>Pull ≥ ' + usd(p.usd * 3) + '</small><b>' + fmtChance(p.x3) + '</b></span>' +
    '</div>';
  }

  // Full odds table: every card in the pack with its value and chance.
  function oddsHTML(p) {
    var list = ui.showAllOdds ? p.pool : p.pool.slice(0, 25);
    var rows = list.map(function (e) {
      var c = D.cardById[e.id];
      return '<tr><td><button class="linkish" data-act="zoom" data-id="' + c.id + '">' + esc(c.name) + '</button><div class="muted small">' + esc(seriesOf(c).name) + ' · ' + esc(c.no) + '</div></td>' +
        '<td><span class="rbadge" style="--rc:var(--r-' + c.tier + ')">' + esc(c.code) + '</span></td>' +
        '<td class="num">' + usd(c.usd) + '</td><td class="num"><b>' + fmtChance(e.p) + '</b></td><td class="num muted">' + oneIn(e.p) + '</td></tr>';
    }).join('');
    return '<div class="table-scroll"><table class="rates"><thead><tr><th>Card</th><th>Rarity</th><th class="num">Est. value</th><th class="num">Chance</th><th class="num">Odds</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (p.pool.length > 25 ? '<button class="btn btn-sm" data-act="all-odds">' + (ui.showAllOdds ? 'Show top 25' : 'Show all ' + p.pool.length + ' cards') + '</button>' : '') +
      '<p class="muted small">Every card in this pack is listed with its exact chance. Chances are set so the average card is worth ' + Math.round(D.EV_RATIO * 100) + '% of the pack price (' + usd(p.ev) + ' for ' + usd(p.usd) + '). Values are estimates and will follow a live price feed at launch. Each rip is independent; there is no pity.</p>';
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

  /* ---------- layout ---------- */
  function topbarHTML() {
    var st = store.state;
    var u = st.user;
    var nav = u ? '<nav class="nav" aria-label="Main">' +
      [['packs', 'Packs'], ['vault', 'Vault'], ['whitelist', 'Whitelist'], ['ranks', 'Ranks']].map(function (n) {
        return '<a href="#' + n[0] + '"' + (ui.route === n[0] ? ' aria-current="page"' : '') + '>' + n[1] + (n[0] === 'vault' && st.vault.length ? ' <span class="nav-count num">' + st.vault.length + '</span>' : '') + '</a>';
      }).join('') + '</nav>' : '';
    var right = u
      ? '<div class="balance" title="' + D.TOKEN + ' balance">' + COIN + '<span class="num">' + fmt(st.balance) + '</span><span class="muted bal-label">' + D.TOKEN + ' · ' + tokenUsd(st.balance) + '</span></div>' +
        '<div class="user-chip"><span class="avatar">' + (u.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : esc(u.handle.slice(0, 2).toUpperCase())) + '</span><span class="uh">@' + esc(u.handle) + '</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="logout">Log out</button>'
      : '<button class="btn btn-x btn-sm" data-act="connect">' + X_SVG + 'Connect X</button>';
    return '<header class="topbar"><div class="wrap">' +
      '<a class="brand" href="#packs"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">POKENEAR</span></a>' +
      (store.mode === 'local' ? '<span class="mode-pill" title="No server connected. Progress is saved in this browser only.">Demo</span>' : '') +
      nav + '<div class="top-right">' + right + '</div></div></header>';
  }

  function footerHTML() {
    return '<footer><div class="wrap"><span>Prices in USD, paid in ' + D.TOKEN + ' (demo peg 1 ' + D.TOKEN + ' = ' + usd(D.TOKEN_USD) + '). Card values are estimates. Card data: TCGdex. Pokémon is a trademark of Nintendo / The Pokémon Company; Pokenear is not affiliated with them.</span>' +
      '<span>Follow <a href="https://x.com/' + D.X_HANDLE + '" target="_blank" rel="noopener">@' + D.X_HANDLE + '</a></span></div></footer>';
  }

  function step(n, title, body) {
    return '<div class="step"><span class="n">' + n + '</span><h3>' + title + '</h3><p>' + body + '</p></div>';
  }

  function packTileHTML(p, interactive) {
    var top = p.top[0];
    var inner = '<span class="tag">' + esc(p.tag) + '</span>' + packArtHTML(p) +
      '<span class="pt-body"><span class="pt-price">' + usd(p.usd) + '</span>' +
      '<span class="pt-name">' + esc(p.name) + '</span>' +
      '<span class="pt-hit">Top hit: <b>' + esc(top.name) + '</b> ' + esc(top.code) + ' · ' + usd(top.usd) + '</span>' +
      '<span class="pt-meta">EV ' + usd(p.ev) + ' · ' + fmtChance(p.beat) + ' beat the price</span></span>';
    if (!interactive) return '<div class="pack-tile static" style="--h:' + p.hue + '">' + inner + '</div>';
    return '<button class="pack-tile" style="--h:' + p.hue + '" data-act="pack" data-id="' + p.id + '" aria-pressed="' + (p.id === ui.pack) + '">' + inner + '</button>';
  }
  /* ---------- landing ---------- */
  function landingHTML() {
    var fan = ['meg-188', 'mew-199', 'blk-172'].map(function (id) { return D.cardById[id] ? cardHTML(D.cardById[id]) : ''; }).join('');
    var refNote = store.ref ? '<p class="demo-note gold-note">Invite code <b class="num">' + esc(store.ref) + '</b> applied. Connect X to get +' + fmt(E.referredBonus) + ' ' + D.TOKEN + ' on top of the welcome credit.</p>' : '';
    var seen = {};
    var hits = [];
    D.PACKS.slice().reverse().forEach(function (p) { p.top.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; hits.push(c); } }); });
    hits = hits.slice(0, 14);
    var starter = D.PACKS[0];
    return '<section class="hero">' +
      '<div class="hero-copy">' +
        '<span class="eyebrow"><span class="live-dot"></span>Season 1 · Pokémon packs live</span>' +
        '<h1>Rip Pokémon cards. Sell back instantly. Earn the <span class="gold">' + D.TOKEN + '</span> whitelist.</h1>' +
        '<p class="lede">Packs from <b>' + usd(starter.usd) + '</b>, paid in ' + D.TOKEN + '. Every pack shows the exact chance of every card, the average card is worth ' + Math.round(D.EV_RATIO * 100) + '% of the price, and you can sell any pull back for ' + Math.round(D.BUYBACK_RATE * 100) + '% of its value on the spot.</p>' +
        refNote +
        '<div class="hero-cta"><button class="btn btn-x btn-lg" data-act="connect">' + X_SVG + 'Connect with X</button><a class="btn btn-ghost btn-lg" href="#rates" data-act="scroll-rates">See the odds</a></div>' +
        '<div><div class="eyebrow" style="margin-bottom:8px">Season 1 closes in</div>' + countdownHTML() + '</div>' +
      '</div>' +
      '<div class="fan" aria-hidden="true">' + fan + '</div>' +
    '</section>' +
    '<section class="hits-band" aria-label="Top hits you can pull"><div class="eyebrow">Top hits in the packs</div><div class="marquee"><div class="marquee-track">' +
      hits.concat(hits).map(function (c) { return '<div class="mq-card">' + cardHTML(c) + '<span class="mq-val">' + usd(c.usd) + '</span></div>'; }).join('') +
    '</div></div></section>' +
    '<section class="view" style="gap:14px"><div class="section-head"><h2>Packs</h2><span class="muted">' + usd(D.PACKS[0].usd) + ' to ' + usd(D.PACKS[D.PACKS.length - 1].usd) + ' · ' + fmt(D.ALL_CARDS.length) + ' real cards</span></div>' +
      '<div class="pack-grid">' + D.PACKS.map(function (p) { return packTileHTML(p, false); }).join('') + '</div></section>' +
    '<section class="panel"><div class="steps">' +
      step(1, 'Connect X', 'Your X account is your Pokenear profile and your invite code.') +
      step(2, 'Pick a pack', 'From ' + usd(starter.usd) + '. Every card and its chance is listed before you rip.') +
      step(3, 'Keep or sell back', 'Hold the card in your vault or take ' + Math.round(D.BUYBACK_RATE * 100) + '% of its value right away.') +
      step(4, 'Lock your spot', 'Finish the quests and invite friends to claim a numbered whitelist pass.') +
    '</div></section>' +
    '<section class="panel" id="rates"><div class="section-head" style="margin-bottom:12px"><h2>' + esc(starter.name) + ' odds</h2><span class="muted">Every pack publishes its full card list</span></div>' + packStatsHTML(starter) + oddsHTML(starter) + '</section>';
  }

  /* ---------- packs ---------- */
  function packsHTML() {
    var st = store.state;
    var p = D.packById[ui.pack];
    var dailyWait = st.lastDaily + E.dailyCooldownMs - Date.now();
    var recent = st.history.slice(0, 10).filter(function (h) { return D.cardById[h.id]; });
    var buttons = D.MULTI.map(function (n, i) {
      var cost = p.price * n;
      return '<button class="btn buy' + (i === 0 ? ' btn-gold' : '') + '" data-act="rip" data-count="' + n + '"' + (st.balance < cost ? ' disabled' : '') + '>' +
        '<span class="buy-name">Rip ' + n + (n > 1 ? ' cards' : ' card') + '</span><span class="buy-usd">' + usd(p.usd * n) + '</span>' +
        '<small>' + COIN + fmt(cost) + ' ' + D.TOKEN + '</small></button>';
    }).join('');
    return '<section class="season"><div><div class="eyebrow"><span class="live-dot"></span>Season 1 live</div><h2>Whitelist mint closes soon</h2></div>' +
        '<div class="season-right">' + countdownHTML() +
        (dailyWait > 0
          ? '<button class="btn" disabled>Daily drop in ' + Math.ceil(dailyWait / 3600000) + 'h</button>'
          : '<button class="btn btn-gold" data-act="daily">' + COIN + ' Claim daily ' + fmt(E.dailyReward) + '</button>') + '</div></section>' +
      '<section class="panel pull-stage">' +
        '<div class="stage-pack">' + packArtHTML(p) + '</div>' +
        '<div class="pull-info">' +
          '<div><div class="eyebrow">Pokémon TCG · ' + p.pool.length + ' cards from ' + usd(p.min) + ' to ' + usd(p.top[0].usd) + ' · ' + (st.pulls[p.id] || 0) + ' ripped</div><h2>' + esc(p.name) + '</h2></div>' +
          '<div class="pull-buttons">' + buttons + '</div>' +
          (st.balance < p.price ? '<p class="demo-note">You need ' + fmt(p.price) + ' ' + D.TOKEN + ' (' + usd(p.usd) + ') for this pack. Claim the daily drop, sell back cards in your vault, or invite friends.</p>' : '') +
          packStatsHTML(p) +
          '<div><div class="eyebrow" style="margin-bottom:10px">Top hits</div><div class="chase-row">' +
            p.top.slice(0, 6).map(function (c) { return slotHTML(c, { chance: chanceOf(p, c.id) }); }).join('') + '</div></div>' +
        '</div></section>' +
      '<section class="view" style="gap:14px"><div class="section-head"><h2>Choose a pack</h2><span class="muted">One card per rip · odds published for every card</span></div>' +
        '<div class="pack-grid">' + D.PACKS.map(function (x) { return packTileHTML(x, true); }).join('') + '</div></section>' +
      (recent.length ? '<section class="view" style="gap:14px"><div class="section-head"><h2>Your latest pulls</h2><a href="#vault" class="muted">Open vault</a></div><div class="mini-cards">' +
        recent.map(function (h) { return slotHTML(D.cardById[h.id], {}); }).join('') + '</div></section>' : '') +
      '<section class="panel" id="rates"><div class="section-head" style="margin-bottom:12px"><h2>' + esc(p.name) + ' odds</h2><span class="muted">' + p.pool.length + ' cards</span></div>' + oddsHTML(p) + '</section>';
  }

  // A card with its value (and optionally its chance) underneath; opens the zoom view.
  function slotHTML(card, opts) {
    opts = opts || {};
    return '<div class="slot"><button data-act="zoom" data-id="' + esc(card.id) + '" aria-label="' + esc(card.name + ', ' + card.rarity) + '">' + cardHTML(card) + '</button>' +
      '<div class="slot-cap"><b>' + usd(card.usd) + '</b>' + (opts.chance ? '<span>' + fmtChance(opts.chance) + '</span>' : '') + '</div></div>';
  }

  /* ---------- vault ---------- */
  function vaultHTML() {
    var st = store.state;
    var items = st.vault.slice();
    if (ui.vaultSort === 'value') items.sort(function (a, b) { return D.cardById[b.id].usd - D.cardById[a.id].usd; });
    else items.sort(function (a, b) { return b.uid - a.uid; });
    var total = engine.vaultValue(st);
    var buyAll = items.reduce(function (n, it) { return n + D.cardById[it.id].buyback; }, 0);
    var sorts = [['value', 'Highest value'], ['new', 'Newest']];
    return '<section class="section-head"><div><div class="eyebrow">Your cards</div><h2 class="page-title">Vault</h2></div>' +
      '<div class="vault-stats"><div class="stat"><b>' + items.length + '</b><span>Cards</span></div><div class="stat"><b>' + usd(total) + '</b><span>Est. value</span></div><div class="stat"><b>' + tokenUsd(buyAll) + '</b><span>Buyback now</span></div></div></section>' +
      (items.length
        ? '<div class="section-head"><div class="binder-tabs" role="group" aria-label="Sort">' + sorts.map(function (s) { return '<button class="chip-btn sm" data-act="vsort" data-id="' + s[0] + '" aria-pressed="' + (ui.vaultSort === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div>' +
          '<p class="muted small">Redeeming the physical card opens at launch.</p></div>' +
          '<div class="binder-grid">' + items.map(function (it) {
            var c = D.cardById[it.id];
            return '<div class="slot vault-item"><button data-act="zoom" data-id="' + c.id + '" aria-label="' + esc(c.name) + '">' + cardHTML(c) + '</button>' +
              '<div class="slot-cap"><b>' + usd(c.usd) + '</b><span>' + esc(c.code) + '</span></div>' +
              '<button class="btn btn-sm sell" data-act="sell" data-uid="' + it.uid + '">Sell back ' + tokenUsd(c.buyback) + '</button></div>';
          }).join('') + '</div>'
        : '<div class="panel empty">Your vault is empty. <a href="#packs">Rip a pack</a> to pull your first card.</div>');
  }

  /* ---------- whitelist ---------- */
  function whitelistHTML() {
    var st = store.state;
    var wl = engine.whitelistStatus(st);
    var link = inviteLink();
    var postText = 'Ripping Pokémon cards on @' + D.X_HANDLE + ' with published odds and instant buyback, farming ' + D.TOKEN + ' for the Season 1 whitelist. Join with my link and get +' + fmt(E.referredBonus) + ' bonus: ' + link;
    function quest(id, title, sub, action, reward) {
      var done = wl.checks[id];
      return '<li class="quest' + (done ? ' done' : '') + '"><span class="tick" aria-hidden="true">✓</span><div><div class="q-title">' + title + '</div><div class="q-sub">' + sub + '</div></div><div class="q-act">' +
        (reward ? '<span class="reward">' + COIN + '+' + reward + '</span>' : '') + (done ? '<span class="done-txt">Done</span>' : action) + '</div></li>';
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
    var spot = st.whitelist ? String(st.whitelist.spot).padStart(4, '0') : '';
    var pass = st.whitelist
      ? '<div class="wl-pass"><div class="eyebrow" style="color:inherit">Season 1 Whitelist Pass</div><h3>You are on the list</h3><div class="spot">#' + spot + '</div><div>@' + esc(st.user.handle) + ' · ' + fmt(st.earned) + ' ' + D.TOKEN + ' earned</div>' +
        '<div><a class="btn btn-x" href="' + intentPost('I just locked whitelist spot #' + spot + ' for ' + D.TOKEN + ' on @' + D.X_HANDLE + '. Get yours before Season 1 closes: ' + link) + '" target="_blank" rel="noopener">' + X_SVG + 'Share my pass</a></div></div>'
      : '<div class="panel" style="display:grid;gap:12px"><b>Claim your whitelist pass</b><p class="muted small">Finish all ' + wl.total + ' quests to get a numbered pass for the ' + D.TOKEN + ' launch.</p>' +
        '<button class="btn btn-gold btn-lg" data-act="joinWhitelist"' + (wl.eligible ? '' : ' disabled') + '>' + (wl.eligible ? 'Join the whitelist' : (wl.total - wl.done) + ' quests left') + '</button></div>';

    return '<section class="section-head"><div><div class="eyebrow">Season 1</div><h2 class="page-title">Whitelist</h2></div>' + countdownHTML() + '</section>' +
      '<div class="wl-grid">' +
        '<section class="panel" style="display:grid;gap:18px">' +
          '<div class="wl-status"><div class="ring" style="--p:' + Math.round(wl.done / wl.total * 100) + '"><div><b class="num">' + wl.done + '/' + wl.total + '</b><small>quests</small></div></div>' +
            '<div><h3 style="font-size:24px">' + (st.whitelist ? 'Whitelisted' : wl.eligible ? 'Ready to join' : 'Not whitelisted yet') + '</h3><p class="muted small" style="margin-top:4px">Quest rewards are paid in ' + D.TOKEN + ' the moment you complete them.</p></div></div>' +
          '<ul class="quests">' +
            quest('connect', 'Connect your X account', 'Connected as @' + esc(st.user.handle), '', 0) +
            quest('follow', 'Follow @' + D.X_HANDLE + ' on X', 'Opens X in a new tab, then confirm here.', followAct, 100) +
            quest('post', 'Post your invite link on X', 'Shares a ready-made post with your code.', postAct, 150) +
            quest('invites', 'Invite ' + E.whitelistInvites + ' friends', '<span class="num">' + Math.min(st.invites, E.whitelistInvites) + '/' + E.whitelistInvites + '</span> joined · +' + fmt(E.inviteReward) + ' per friend', inviteAct, 0) +
            quest('pulls', 'Rip your first pack', 'Packs from ' + usd(D.PACKS[0].usd), '<a class="btn btn-sm" href="#packs">Open packs</a>', 0) +
          '</ul>' +
          (store.mode === 'local' ? '<p class="demo-note">Demo mode: X follows and posts are self-confirmed, and invites are simulated because there is no server tracking sign-ups. Run the Pokenear server with X API keys for real login and referral tracking.</p>' : '') +
        '</section>' +
        '<div style="display:grid;gap:24px">' + pass +
          '<section class="panel" style="display:grid;gap:14px"><div><b>Invite friends</b><p class="muted small">Friends get +' + fmt(E.referredBonus) + ' ' + D.TOKEN + ' on sign-up. You get ' + fmt(E.inviteReward) + ' for each one.</p></div>' +
            '<div class="ref-box"><input id="ref-link" readonly value="' + esc(link) + '" aria-label="Your invite link"><button class="btn" data-act="copy">Copy</button></div>' +
            '<a class="btn btn-x" href="' + intentPost(postText) + '" target="_blank" rel="noopener">' + X_SVG + 'Share invite on X</a>' +
            '<div class="stats-row"><div class="stat"><b>' + st.invites + '</b><span>Friends joined</span></div><div class="stat"><b>' + fmt(st.invites * E.inviteReward) + '</b><span>' + D.TOKEN + ' from invites</span></div><div class="stat"><b class="num">' + esc(st.user.refCode) + '</b><span>Your code</span></div></div>' +
          '</section>' +
        '</div>' +
      '</div>';
  }

  /* ---------- leaderboard ---------- */
  var SAMPLE = [
    ['Holo Hunter', 'holo_hunter', 2840, 41, true], ['Pack Ripper', 'packripper', 1915, 33, true], ['SIR Seeker', 'sirseeker', 1290, 26, true],
    ['Vault Queen', 'vaultqueen', 948, 21, true], ['Chase Mode', 'chasemode', 612, 14, false], ['Mega Fan', 'megafan', 402, 9, false],
    ['Foil Fanatic', 'foilfanatic', 215, 6, false], ['Daily Grinder', 'dailygrinder', 64, 3, false]
  ];
  function ranksHTML() {
    var st = store.state;
    var me = { name: st.user.name, handle: st.user.handle, score: engine.vaultValue(st), cards: st.vault.length, wl: !!st.whitelist, me: true };
    var rows, isSample = false;
    if (ui.leaderboard) {
      rows = ui.leaderboard.map(function (r) { return { name: r.name, handle: r.handle, score: r.score, cards: r.cards, wl: r.wl, me: r.handle === st.user.handle }; });
    } else {
      isSample = true;
      rows = SAMPLE.map(function (r) { return { name: r[0], handle: r[1], score: r[2], cards: r[3], wl: r[4], sample: true }; }).concat([me]);
    }
    rows.sort(function (a, b) { return b.score - a.score; });
    return '<section class="section-head"><div><div class="eyebrow">Vault value</div><h2 class="page-title">Ranks</h2></div><span class="muted small">Ranked by the estimated value of the cards each collector holds</span></section>' +
      (isSample ? '<p class="demo-note">Demo mode: rows marked Sample are placeholders. With the server running, this table lists real collectors.</p>' : '') +
      '<section class="panel table-scroll" style="padding:8px 12px"><table class="lb"><thead><tr><th>#</th><th>Collector</th><th class="num">Cards</th><th class="num">Vault value</th><th>Whitelist</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr' + (r.me ? ' class="me"' : '') + '><td class="rank">' + (i + 1) + '</td><td><div class="who"><span class="avatar">' + esc(r.handle.slice(0, 2).toUpperCase()) + '</span><div><b>' + esc(r.name) + (r.me ? ' (you)' : '') + '</b><div class="muted small">@' + esc(r.handle) + (r.sample ? ' <span class="sample">Sample</span>' : '') + '</div></div></div></td>' +
          '<td class="num">' + r.cards + '</td><td class="num"><b>' + usd(r.score) + '</b></td><td>' + (r.wl ? '<span class="done-txt">Whitelisted</span>' : '<span class="muted">Not yet</span>') + '</td></tr>';
      }).join('') + '</tbody></table></section>';
  }

  /* ---------- main render ---------- */
  function render() {
    var st = store.state;
    var body;
    if (!st.user) body = landingHTML();
    else if (ui.route === 'vault') body = vaultHTML();
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

  /* ---------- modals ---------- */
  function openConnect() {
    if (store.mode === 'live') { store.connectX(); return; }
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><form class="modal" id="connect-form" role="dialog" aria-modal="true" aria-labelledby="connect-title">' +
      '<div class="modal-title">' + X_SVG + '<h2 id="connect-title">Connect X</h2></div>' +
      '<p class="muted small">This preview runs without X API keys, so type your handle to continue. With the Pokenear server configured, this button opens the real X sign-in page.</p>' +
      '<div class="field"><label for="x-handle">X handle</label><div class="input-at"><span>@</span><input id="x-handle" name="handle" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16" placeholder="yourname" required></div><div class="err" id="connect-err"></div></div>' +
      (store.ref ? '<p class="reward">' + COIN + 'Invite code ' + esc(store.ref) + ' gives +' + fmt(E.referredBonus) + ' bonus</p>' : '') +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">Cancel</button><button type="submit" class="btn btn-x">' + X_SVG + 'Connect</button></div>' +
      '</form></div>';
    $('#x-handle').focus();
  }

  function openZoom(id) {
    var card = D.cardById[id];
    if (!card) return;
    var s = seriesOf(card);
    var held = store.state.vault ? store.state.vault.filter(function (it) { return it.id === id; }).length : 0;
    var inPacks = D.PACKS.filter(function (p) { return chanceOf(p, id) > 0; }).map(function (p) { return p.name + ' ' + fmtChance(chanceOf(p, id)); });
    var rows = [
      ['Set', s.name + ' (' + s.short + ')'],
      ['Number', card.no],
      ['Rarity', card.rarity.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ' (' + card.code + ')'],
      ['Est. value', usd(card.usd)],
      ['Instant buyback', fmt(card.buyback) + ' ' + D.TOKEN + ' · ' + tokenUsd(card.buyback)],
      ['Chance', inPacks.length ? inPacks.join(' · ') : 'Not in any pack yet'],
      ['In your vault', held ? '×' + held : 'Not yet']
    ];
    if (card.illus) rows.splice(3, 0, ['Illustrator', card.illus]);
    var best = D.PACKS.filter(function (p) { return chanceOf(p, id) > 0; })[0];
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><div class="modal zoom" role="dialog" aria-modal="true" aria-label="' + esc(card.name) + '">' +
      '<div class="zoom-card">' + cardHTML(card) + '</div>' +
      '<div class="zoom-info"><div class="eyebrow">Pokémon TCG</div><h2>' + esc(card.name) + '</h2>' +
      '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
      '<div class="modal-actions" style="justify-content:start">' + (best && store.state.user ? '<button class="btn btn-gold" data-act="go-pack" data-id="' + best.id + '">Rip the ' + esc(best.name) + '</button>' : '') + '<button class="btn btn-ghost" data-act="close-modal">Close</button></div></div>' +
      '</div></div>';
  }
  function closeModal() { $('#modal').innerHTML = ''; }

  /* ---------- rip ---------- */
  function startRip(count) {
    if (ui.busy) return;
    var packId = ui.pack;
    run({ type: 'pull', pack: packId, count: count }, function (result) {
      if (!result || !result.items) return;
      ui.opening = { pack: packId, items: result.items, count: count, stage: 'pack', revealed: {}, sold: {} };
      renderOverlay();
    });
  }
  function allRevealed() {
    var o = ui.opening;
    return o.items.every(function (it, i) { return o.revealed[i]; });
  }

  function renderOverlay() {
    var o = ui.opening;
    var host = $('#overlay');
    if (!o) { host.innerHTML = ''; doc.body.style.overflow = ''; return; }
    doc.body.style.overflow = 'hidden';
    var p = D.packById[o.pack];
    var html;
    if (o.stage === 'pack') {
      html = '<div class="open-stage"><div class="eyebrow">' + esc(p.name) + ' · ' + o.items.length + ' card' + (o.items.length > 1 ? 's' : '') + '</div>' +
        '<button class="big-pack" data-act="tear" aria-label="Tear open the pack">' + packArtHTML(p) + '</button>' +
        '<h2>Tap the pack to rip it</h2></div>';
    } else {
      var all = allRevealed();
      var grid = o.items.map(function (it, i) {
        var card = D.cardById[it.id];
        var t = rar(card.tier);
        var hint = card.usd >= p.usd ? ' hint-UR' : t.rank >= rar('SR').rank ? ' hint-SR' : '';
        var sold = o.sold[it.uid];
        var below = all
          ? '<div class="rip-cap' + (card.usd >= p.usd ? ' win' : '') + '"><b>' + usd(card.usd) + '</b><span>' + esc(card.code) + '</span></div>' +
            (sold ? '<div class="sold-tag">Sold for ' + tokenUsd(card.buyback) + '</div>'
              : '<button class="btn btn-sm sell" data-act="sell-rip" data-uid="' + it.uid + '">Sell back ' + tokenUsd(card.buyback) + '</button>')
          : '';
        return '<div class="rip-slot"><button class="flip' + hint + (o.revealed[i] ? ' revealed' : '') + (sold ? ' sold' : '') + '" data-act="flip" data-i="' + i + '" style="animation-delay:' + (i * 80) + 'ms" aria-label="' + (o.revealed[i] ? esc(card.name + ', ' + card.rarity) : 'Reveal card ' + (i + 1)) + '">' +
          '<div class="flip-inner"><div class="face back"><div class="card-back"><span class="brand-mark"></span></div></div><div class="face front">' + cardHTML(card) + '</div></div></button>' + below + '</div>';
      }).join('');
      var summary = '', actions;
      if (all) {
        var total = o.items.reduce(function (n, it) { return n + D.cardById[it.id].usd; }, 0);
        var spent = p.usd * o.items.length;
        var best = o.items.slice().sort(function (a, b) { return D.cardById[b.id].usd - D.cardById[a.id].usd; })[0];
        var bestCard = D.cardById[best.id];
        var unsold = o.items.filter(function (it) { return !o.sold[it.uid]; });
        var shareText = 'Just pulled ' + bestCard.name + ' (' + bestCard.code + ', ' + usd(bestCard.usd) + ') from a ' + usd(p.usd) + ' ' + p.name + ' on @' + D.X_HANDLE + '. Join me: ' + inviteLink();
        summary = '<div class="summary"><span>Pulled <b>' + usd(Math.round(total * 100) / 100) + '</b> for <b>' + usd(spent) + '</b></span>' +
          '<span class="' + (total >= spent ? 'up' : 'down') + '">' + (total >= spent ? '+' : '−') + usd(Math.abs(Math.round((total - spent) * 100) / 100)) + '</span></div>';
        actions = '<a class="btn btn-x" href="' + intentPost(shareText) + '" target="_blank" rel="noopener">' + X_SVG + 'Share pull</a>' +
          (unsold.length > 1 ? '<button class="btn" data-act="sell-all-rip">Sell back all · ' + tokenUsd(unsold.reduce(function (n, it) { return n + D.cardById[it.id].buyback; }, 0)) + '</button>' : '') +
          '<button class="btn btn-gold" data-act="again"' + (store.state.balance < p.price * o.count ? ' disabled' : '') + '>Rip again · ' + usd(p.usd * o.count) + '</button>' +
          '<button class="btn" data-act="close-open">Keep in vault</button>';
      } else {
        actions = o.items.length > 1 ? '<button class="btn btn-gold" data-act="reveal-all">Reveal all</button>' : '';
      }
      html = '<div class="open-stage"><div class="eyebrow">' + esc(p.name) + '</div><h2>' + (all ? 'Your pull' : 'Tap to reveal') + '</h2>' +
        '<div class="reveal-grid' + (o.items.length === 1 ? ' single' : ' five') + '">' + grid + '</div>' + summary + '<div class="open-actions">' + actions + '</div></div>';
    }
    host.innerHTML = '<div class="overlay" role="dialog" aria-modal="true" aria-label="Pack opening">' + html + '</div><div class="flash" id="flash"></div>';
  }

  function flip(i) {
    var o = ui.opening;
    if (!o || o.stage !== 'cards' || o.revealed[i]) return;
    o.revealed[i] = true;
    var btn = doc.querySelector('.flip[data-i="' + i + '"]');
    if (btn) btn.classList.add('revealed');
    var card = D.cardById[o.items[i].id];
    var p = D.packById[o.pack];
    if (card.usd >= p.usd * 3) flash('var(--r-SEC)');
    else if (card.usd >= p.usd) flash('var(--r-UR)');
    if (allRevealed()) setTimeout(renderOverlay, 650);
  }
  function flash(color) {
    var f = $('#flash');
    if (!f) return;
    f.style.background = 'radial-gradient(circle, ' + color + ', transparent 70%)';
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }
  function revealAll() {
    var o = ui.opening;
    var k = 0;
    o.items.forEach(function (it, i) { if (!o.revealed[i]) setTimeout(function () { flip(i); }, (k++) * 160); });
  }
  function closeOpening() { ui.opening = null; renderOverlay(); render(); }

  function sellFromRip(uids) {
    run({ type: 'buyback', uids: uids }, function (r) {
      uids.forEach(function (u) { ui.opening.sold[u] = true; });
      toast('Sold back for ' + fmt(r.amount) + ' ' + D.TOKEN + ' (' + tokenUsd(r.amount) + ').');
      renderOverlay();
    });
  }

  /* ---------- events ---------- */
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    var uid = Number(el.getAttribute('data-uid'));
    switch (act) {
      case 'connect': openConnect(); break;
      case 'close-modal': if (e.target === el || el.tagName === 'BUTTON') closeModal(); break;
      case 'logout': store.logout().then(function () { ui.clicked = {}; toast('Logged out.'); }); break;
      case 'scroll-rates': e.preventDefault(); var r = $('#rates'); if (r) r.scrollIntoView({ behavior: 'smooth' }); break;
      case 'pack': ui.pack = id; ui.showAllOdds = false; render(); var st = $('.pull-stage'); if (st) st.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
      case 'go-pack': e.preventDefault(); closeModal(); ui.pack = id; if (root.location.hash !== '#packs') root.location.hash = 'packs'; else render(); break;
      case 'all-odds': ui.showAllOdds = !ui.showAllOdds; render(); break;
      case 'zoom': openZoom(id); break;
      case 'rip': startRip(Number(el.getAttribute('data-count'))); break;
      case 'daily': run({ type: 'daily' }, function (r) { toast('+' + r.amount + ' ' + D.TOKEN + ' claimed.'); }); break;
      case 'vsort': ui.vaultSort = id; render(); break;
      case 'sell': run({ type: 'buyback', uid: uid }, function (r) { toast('Sold back for ' + fmt(r.amount) + ' ' + D.TOKEN + ' (' + tokenUsd(r.amount) + ').'); }); break;
      case 'sell-rip': sellFromRip([uid]); break;
      case 'sell-all-rip': sellFromRip(ui.opening.items.filter(function (it) { return !ui.opening.sold[it.uid]; }).map(function (it) { return it.uid; })); break;
      case 'xlink': ui.clicked[id] = true; setTimeout(render, 300); break;
      case 'task': run({ type: 'task', id: id }, function (r) { toast('Quest complete. +' + r.amount + ' ' + D.TOKEN + '.'); }); break;
      case 'demoInvite': run({ type: 'inviteJoined' }, function (r) { toast('A friend joined. +' + r.amount + ' ' + D.TOKEN + '.'); }); break;
      case 'joinWhitelist': run({ type: 'joinWhitelist' }, function (r) { toast('Whitelisted! Your spot is #' + r.spot + '.'); }); break;
      case 'copy': copyLink(); break;
      case 'tear':
        el.classList.add('tearing');
        el.disabled = true;
        setTimeout(function () {
          if (!ui.opening) return;
          ui.opening.stage = 'cards';
          renderOverlay();
          if (ui.opening.items.length === 1) setTimeout(function () { flip(0); }, 450);
        }, 620);
        break;
      case 'flip': flip(Number(el.getAttribute('data-i'))); break;
      case 'reveal-all': revealAll(); break;
      case 'again': var n = ui.opening.count; ui.opening = null; renderOverlay(); startRip(n); break;
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
      $('#modal').innerHTML = '';
      root.location.hash = 'packs';
      setRoute();
      toast('Welcome @' + handle + '! +' + fmt(r.bonus) + ' ' + D.TOKEN + ' (' + tokenUsd(r.bonus) + ' demo credit) added.');
    }).catch(function (err) { $('#connect-err').textContent = err.message; });
  }

  // Holographic tilt for SR and above.
  var tilted = null;
  function onMove(e) {
    var card = e.target.closest && e.target.closest('.card.holo');
    if (tilted && tilted !== card) resetTilt();
    if (!card || e.pointerType === 'touch' || card.closest('.marquee')) return;
    var b = card.getBoundingClientRect();
    var x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    card.style.setProperty('--mx', (x * 100) + '%');
    card.style.setProperty('--my', (y * 100) + '%');
    card.style.setProperty('--ry', ((x - 0.5) * 16) + 'deg');
    card.style.setProperty('--rx', ((0.5 - y) * 16) + 'deg');
    tilted = card;
  }
  function resetTilt() {
    if (!tilted) return;
    ['--mx', '--my', '--rx', '--ry'].forEach(function (p) { tilted.style.removeProperty(p); });
    tilted = null;
  }

  // Official scans: show when loaded, drop when blocked or missing.
  function onImgLoad(e) { if (e.target.classList && e.target.classList.contains('real')) e.target.classList.add('ok'); }
  function onImgError(e) { if (e.target.classList && e.target.classList.contains('real')) e.target.remove(); }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if ($('#modal').innerHTML) closeModal();
    else if (ui.opening && ui.opening.stage === 'cards') {
      if (!allRevealed()) revealAll(); else closeOpening();
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    var app = $('#app');
    ['overlay', 'modal', 'toasts'].forEach(function (id) {
      if (!$('#' + id)) { var d = doc.createElement('div'); d.id = id; if (id === 'toasts') d.className = 'toasts'; doc.body.appendChild(d); }
    });
    app.innerHTML = '<div class="wrap muted" style="padding-block:80px;text-align:center">Loading Pokenear…</div>';
    doc.addEventListener('click', onClick);
    doc.addEventListener('submit', onSubmit);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('load', onImgLoad, true);
    doc.addEventListener('error', onImgError, true);
    root.addEventListener('hashchange', setRoute);
    store.subscribe(function () { if (!ui.opening) render(); });
    store.init().then(function () {
      if (store.mode === 'live' && /[?&]x_error=/.test(root.location.search)) toast('X sign-in did not finish. Try again.', true);
      setRoute();
      setInterval(tickCountdown, 1000);
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

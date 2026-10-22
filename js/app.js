/* StonkPacks UI. Renders from store.state; all game rules live in engine.js.
   Gacha model: tiered packs, one card per pack, published odds, instant 96% buyback.
   Cards are drawn from real set data (js/cards.js). When remote images are allowed,
   the official card scan fades in over the drawn card. */
(function (root) {
  'use strict';

  var D = root.PN.data;
  var engine = root.PN.engine;
  var store = root.PN.store;
  var doc = root.document;
  var CFG = root.PN_CONFIG || {};

  var ROUTES = ['packs', 'vault', 'ranks', 'docs', 'admin'];
  var ui = {
    route: 'packs',
    pack: D.PACKS[0].id,
    vaultSort: 'value',
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
  function buybackUsd(cards) { return usd(cards.reduce(function (n, c) { return n + c.usd; }, 0) * D.BUYBACK_RATE); }
  // Raw NEP-141 amount (string, smallest unit) -> "1,234.5"
  function fmtToken(raw, decimals) {
    if (raw == null || decimals == null || typeof BigInt === 'undefined') return '—';
    var v = BigInt(raw), base = BigInt(10) ** BigInt(decimals);
    var whole = v / base, frac = Number((v % base) * BigInt(100) / base);
    return whole.toLocaleString('en-US') + (frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : '');
  }
  // Live NEAR amount for a pack (from the server's market quote), e.g. "4.0123"; null if unknown.
  function short(a) { a = String(a || ''); return a.length > 20 ? a.slice(0, 6) + '…' + a.slice(-6) : a; }
  function nearQuote(p, n) {
    var g = store.game;
    if (store.mode !== 'live' || !g || !g.prices || g.prices.length < D.PACKS.length || store.isDev()) return null;
    var i = D.PACKS.indexOf(p);
    var raw = (BigInt(g.prices[i]) * BigInt(n || 1)).toString();
    return fmtNear(raw);
  }
  function fmtNear(raw) {
    var dec = (store.game && store.game.decimals) || D.TOKEN_DECIMALS;
    var v = BigInt(raw), unit = BigInt(10) ** BigInt(dec);
    var frac = String(v % unit).padStart(dec, '0').slice(0, 4).replace(/0+$/, '');
    return (v / unit).toLocaleString('en-US') + (frac ? '.' + frac : '');
  }
  // Why packs are closed, in plain words (shown on the packs page).
  function closedReason() {
    if (store.mode !== 'live') return 'Game server not connected: this site cannot reach /api/config.';
    if (store.game && store.game.reason === 'storage') return 'Game database not connected: add Upstash Redis to the Vercel project, then redeploy.';
    if (store.game && store.game.reason === 'treasury') return 'SOL payments open as soon as the treasury wallet is set. Follow @' + D.X_HANDLE + ' for the launch.';
    return 'Waiting for the live ' + D.TOKEN + ' price. Packs open automatically as soon as it loads.';
  }
  function payReady() { return store.mode === 'live' && (store.isDev() || (store.game && store.game.ready)); }
  function buybackReady() { return store.mode === 'live' && (store.isDev() || (store.game && store.game.ready && store.game.buyback)); }
  function seriesOf(card) { return D.seriesById[card.series]; }

  var COIN = '<span class="coin' + (D.CHAIN === 'solana' ? ' sol' : '') + '" aria-hidden="true"></span>';
  var WALLET_SVG = '<svg class="x-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a3 3 0 0 1 3-3h11a1 1 0 0 1 0 2H6a1 1 0 0 0 0 2h13a2 2 0 0 1 2 2v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zm14 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';
  var CHAIN_BADGE = {
    solana: '<span class="chain-dot sol" title="Solana" aria-label="Solana"></span>',
    near: '<span class="chain-dot near" title="NEAR" aria-label="NEAR"></span>'
  };
  var A = root.PN.auth;
  var W = root.PN.wallets;

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

  function run(promiseFn, onDone) {
    if (ui.busy) return Promise.resolve();
    ui.busy = true;
    return promiseFn()
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
  // Black White Rare, Mega Hyper Rare and gold Hyper Rare are etched monochrome foils: their flat
  // scans look washed out on screen, so these use the drawn card with a foil frame instead.
  var MONO_FOIL = { BWR: 1, MUR: 1, HR: 1 };
  function realImg(card) {
    if (CFG.remoteImages === false || !card.img || MONO_FOIL[card.code]) return '';
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
    var cls = 'pk' + (full ? ' full' : '') + (gold ? ' gold' : '') + (card.code === 'BWR' ? ' bwr' : '') + (card.cat === 'Trainer' ? ' trainer' : '') + (card.cat === 'Energy' ? ' energy' : '');
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

  // Booster wrapper look per pack tier: foil colours and the hero Pokémon that breaks out of the window.
  var PACK_LOOK = {
    starter: { hero: 25, foil: ['#7dffcb', '#00ec97', '#004d31'], gems: 1, label: 'Starter', no: '01' },
    rare: { hero: 94, foil: ['#d9d2ff', '#8b7bff', '#241866'], gems: 2, label: 'Rare', no: '02' },
    elite: { hero: 448, foil: ['#b9f0ff', '#2db7ff', '#062d57'], gems: 3, label: 'Elite', no: '03' },
    legend: { hero: 6, foil: ['#fff0b8', '#f5b942', '#5a3200'], gems: 4, label: 'Legend', no: '04' }
  };
  // Fine serrated seal along the top and bottom edge.
  var CRIMP = (function () {
    var pts = [], teeth = 34, depth = 1.1;
    for (var i = 0; i <= teeth; i++) pts.push((i * 100 / teeth).toFixed(2) + '% ' + (i % 2 ? depth : 0) + '%');
    for (var j = teeth; j >= 0; j--) pts.push((j * 100 / teeth).toFixed(2) + '% ' + (100 - (j % 2 ? depth : 0)) + '%');
    return 'polygon(' + pts.join(',') + ')';
  })();

  function packArtHTML(p) {
    var look = PACK_LOOK[p.id] || PACK_LOOK.starter;
    var gems = '';
    for (var i = 0; i < 4; i++) gems += '<i class="' + (i < look.gems ? 'on' : '') + '"></i>';
    return '<div class="booster np-' + p.id + '" style="--f1:' + look.foil[0] + ';--f2:' + look.foil[1] + ';--f3:' + look.foil[2] + '">' +
      '<div class="bw" style="clip-path:' + CRIMP + '">' +
        '<div class="bw-foil"></div><div class="bw-mono">N</div>' +
        '<div class="bw-seal top"></div><div class="bw-seal bottom"></div>' +
        '<div class="bw-head"><img src="assets/brand/stonkpacks-icon.svg" alt=""><span>STONK<b>PACKS</b></span><em>S' + look.no + '</em></div>' +
        '<div class="bw-window"><span class="bw-rays"></span><span class="bw-orb"></span></div>' +
        '<img class="bw-hero" src="' + artUrl(look.hero) + '" alt="" decoding="async">' +
        '<div class="bw-name"><small>Pokémon card pack</small><span>' + esc(look.label) + '</span></div>' +
        '<div class="bw-meta"><span class="bw-gems">' + gems + '</span><span>1 CARD · ' + usd(p.usd) + '</span></div>' +
        '<div class="bw-sheen"></div>' +
      '</div>' +
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
      (buybackReady() ? '<span class="schip"><small>Instant buyback</small><b>' + Math.round(D.BUYBACK_RATE * 100) + '%</b></span>' : '<span class="schip"><small>Top hit</small><b>' + usd(p.top[0].usd) + '</b></span>') +
      '<span class="schip"><small>Pull ≥ ' + usd(p.usd) + '</small><b>' + fmtChance(p.beat) + '</b></span>' +
      '<span class="schip"><small>Pull ≥ ' + usd(p.usd * 3) + '</small><b>' + fmtChance(p.x3) + '</b></span>' +
    '</div>';
  }

  // Top tier cards of a pack: every card worth at least the pack price, best first.
  function topTier(p) {
    var list = p.pool.map(function (e) { return { c: D.cardById[e.id], p: e.p }; })
      .filter(function (x) { return x.c.usd >= p.usd; })
      .sort(function (x, y) { return y.c.usd - x.c.usd; });
    return list.length ? list : p.top.slice(0, 12).map(function (c) { return { c: c, p: chanceOf(p, c.id) }; });
  }

  // Modal shown when a pack is clicked: its top tier cards with value and chance.
  function openPackOdds(p) {
    var list = topTier(p);
    var total = list.reduce(function (a, x) { return a + x.p; }, 0);
    var shown = list.slice(0, 30);
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><div class="modal pack-odds" role="dialog" aria-modal="true" aria-label="' + esc(p.name) + ' top tier">' +
      '<div class="section-head"><div><div class="eyebrow">' + usd(p.usd) + ' · ' + p.pool.length + ' cards</div><h2>' + esc(p.name) + ': top tier</h2></div>' +
      '<button class="btn btn-ghost btn-sm" data-act="close-modal">Close</button></div>' +
      packStatsHTML(p) +
      '<p class="muted small">' + list.length + ' cards worth ' + usd(p.usd) + ' or more · ' + fmtChance(total) + ' chance per pack to pull one.' + (list.length > shown.length ? ' Showing the top ' + shown.length + '.' : '') + '</p>' +
      '<div class="odds-grid">' + shown.map(function (x) {
        return '<div class="slot"><button data-act="zoom" data-id="' + esc(x.c.id) + '" aria-label="' + esc(x.c.name + ', ' + x.c.rarity) + '">' + cardHTML(x.c) + '</button>' +
          '<div class="slot-cap"><b>' + usd(x.c.usd) + '</b><span>' + fmtChance(x.p) + '</span></div>' +
          '<div class="slot-name"><span class="rbadge" style="--rc:var(--r-' + x.c.tier + ')">' + esc(x.c.code) + '</span> ' + esc(x.c.name) + '</div></div>';
      }).join('') + '</div>' +
      (store.state.user ? '<div class="modal-actions" style="justify-content:start"><button class="btn btn-gold" data-act="go-pack" data-id="' + p.id + '">Open the ' + esc(p.name) + '</button></div>' : '') +
    '</div></div>';
  }

  /* ---------- layout ---------- */
  function topbarHTML() {
    var st = store.state;
    var u = st.user;
    var nav = u ? '<nav class="nav" aria-label="Main">' +
      [['packs', 'Packs'], ['vault', 'Vault'], ['ranks', 'Ranks'], ['docs', 'Docs']].concat(store.isAdmin() ? [['admin', 'Admin']] : []).map(function (n) {
        return '<a href="' + link(n[0]) + '"' + (ui.route === n[0] ? ' aria-current="page"' : '') + '>' + n[1] + (n[0] === 'vault' && st.vault.length ? ' <span class="nav-count num">' + st.vault.length + '</span>' : '') + '</a>';
      }).join('') + '</nav>' : '<nav class="nav" aria-label="Main"><a href="' + link('docs') + '"' + (ui.route === 'docs' ? ' aria-current="page"' : '') + '>Docs</a></nav>';
    var right = u
      ? '<div class="balance" title="' + D.TOKEN + ' in your wallet">' + COIN + '<span class="num">' + (ui.balance ? fmtToken(ui.balance.amount, ui.balance.decimals) : '…') + '</span><span class="muted bal-label">' + D.TOKEN + '</span></div>' +
        '<div class="user-chip" title="' + esc(u.address) + '">' + CHAIN_BADGE[u.chain] + '<span class="uh num">' + esc(u.name) + '</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="logout">Log out</button>'
      : '<button class="btn btn-gold btn-sm" data-act="connect">' + WALLET_SVG + 'Connect wallet</button>';
    return '<header class="topbar"><div class="wrap">' +
      '<a class="brand" href="' + link('') + '"><img class="brand-icon" src="assets/brand/stonkpacks-icon.svg" alt="" width="36" height="36"><span class="brand-name">Stonk<b>Packs</b></span></a>' +
      nav + '<div class="top-right">' + right + '</div></div></header>';
  }

  function footerHTML() {
    return '<footer><div class="wrap"><span>Sign in with a Solana wallet. Packs are priced in USD and paid in SOL. Card values are estimates. Card data: TCGdex. Pokémon is a trademark of Nintendo / The Pokémon Company; StonkPacks is not affiliated with them.</span>' +
      '<span class="foot-links"><span class="muted small" title="Site version">v' + D.VERSION + (store.mode === 'live' && store.serverVersion && store.serverVersion !== D.VERSION ? ' · server ' + esc(store.serverVersion) : '') + '</span><a href="' + link('docs') + '">Docs</a><a href="' + link('docs/rng') + '">On-chain RNG</a><a href="' + link('docs/faq') + '">FAQ</a><a href="' + X_URL + '" target="_blank" rel="noopener">' + X_SVG + '@' + D.X_HANDLE + '</a></span>' +
      '</div></footer>';
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
    var seen = {};
    var hits = [];
    D.PACKS.slice().reverse().forEach(function (p) { p.top.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; hits.push(c); } }); });
    hits = hits.slice(0, 14);
    var starter = D.PACKS[0];
    return '<section class="hero">' +
      '<div class="hero-copy">' +
        '<span class="eyebrow"><span class="live-dot"></span>Pokémon packs on Solana · token launching on <a href="' + D.LAUNCHPAD.url + '" target="_blank" rel="noopener">' + D.LAUNCHPAD.name + '</a></span>' +
        '<h1>Open real <span class="gold">Pokémon</span> packs with SOL.</h1>' +
        '<p class="lede">Packs from <b>' + usd(starter.usd) + '</b>, paid in ' + D.TOKEN + '. Every pack shows the exact chance of every card, the average card is worth ' + Math.round(D.EV_RATIO * 100) + '% of the price, and every pull is decided by the Solana block your payment lands in.</p>' +
        '<div class="hero-cta"><button class="btn btn-gold btn-lg" data-act="connect">' + WALLET_SVG + 'Connect wallet</button><a class="btn btn-ghost btn-lg" href="#rates" data-act="scroll-rates">See the odds</a></div>' +
      '</div>' +
      '<div class="fan" aria-hidden="true">' + fan + '</div>' +
    '</section>' +
    '<section class="hits-band" aria-label="Top hits you can pull"><div class="eyebrow">Top hits in the packs</div><div class="marquee"><div class="marquee-track">' +
      hits.concat(hits).map(function (c) { return '<div class="mq-card">' + cardHTML(c) + '<span class="mq-val">' + usd(c.usd) + '</span></div>'; }).join('') +
    '</div></div></section>' +
    '<section class="view" style="gap:14px"><div class="section-head"><h2>Packs</h2><span class="muted">' + usd(D.PACKS[0].usd) + ' to ' + usd(D.PACKS[D.PACKS.length - 1].usd) + ' · ' + fmt(D.ALL_CARDS.length) + ' real cards</span></div>' +
      '<div class="pack-grid" id="rates">' + D.PACKS.map(function (p) { return packTileHTML(p, true); }).join('') + '</div><p class="muted small">Tap a pack to see its top tier cards and odds.</p></section>' +
    '<section class="panel"><div class="steps">' +
      step(1, 'Connect a Solana wallet', 'Phantom, Solflare or Backpack. One signature, no transaction, no fee.') +
      step(2, 'Pick a pack', 'From ' + usd(starter.usd) + '. Every card and its chance is listed before you open it.') +
      step(3, 'Pay in SOL', 'One SOL transfer pays for the pack; the block it lands in decides your card.') +
      step(4, 'Collect', 'Your cards go to your vault with an on-chain proof. Climb the Ranks board.') +
    '</div></section>';
  }

  /* ---------- packs ---------- */
  function packsHTML() {
    var st = store.state;
    var p = D.packById[ui.pack];
    var recent = st.history.slice(0, 10).filter(function (h) { return D.cardById[h.id]; });
    var buttons = D.MULTI.map(function (n, i) {
      return '<button class="btn buy' + (i === 0 ? ' btn-gold' : '') + '" data-act="rip" data-count="' + n + '"' + (payReady() ? '' : ' disabled') + '>' +
        '<span class="buy-name">Open ' + n + (n > 1 ? ' packs' : ' pack') + '</span><span class="buy-usd">' + usd(p.usd * n) + '</span>' +
        '<small>' + COIN + (nearQuote(p, n) ? '≈ ' + nearQuote(p, n) + ' ' + D.TOKEN + ' now' : 'Paid in ' + D.TOKEN) + '</small></button>';
    }).join('');
    var pr = st.pendingRip;
    var openRip = pr ? '<section class="panel open-rip"><div><b>You have an unopened pack</b><p class="muted small">' + esc(D.packById[pr.pack].name) + ' · ' + pr.count + ' pack' + (pr.count > 1 ? 's' : '') + ' · ' + usd(D.packById[pr.pack].usd * pr.count) + '. Finish it to get your cards, or cancel it if you have not paid yet.</p></div>' +
      '<div class="open-actions"><button class="btn btn-gold" data-act="rip-resume">Continue</button><button class="btn" data-act="rip-refund">Cancel</button></div></section>' : '';
    var launch = store.isDev() ? '<p class="demo-note gold-note">Owner wallet ' + esc(st.user.address) + ': packs open free, no payment, and are recorded as owner openings.</p>' : payReady() ? '' : '<section class="daily-bar"><div><div class="eyebrow">Packs paused</div><h2>' + closedReason() + '</h2></div>' +
        '<div class="daily-right"><a class="btn btn-gold" href="' + X_URL + '" target="_blank" rel="noopener">' + X_SVG + 'Follow @' + D.X_HANDLE + '</a></div></section>';
    return openRip + launch +
      '<section class="panel pull-stage">' +
        '<button class="stage-pack" data-act="pack-odds" data-id="' + p.id + '" aria-label="See top tier cards">' + packArtHTML(p) + '</button>' +
        '<div class="pull-info">' +
          '<div><div class="eyebrow">Pokémon TCG · ' + p.pool.length + ' cards from ' + usd(p.min) + ' to ' + usd(p.top[0].usd) + ' · ' + (st.pulls[p.id] || 0) + ' opened</div><h2>' + esc(p.name) + '</h2></div>' +
          '<div class="pull-buttons">' + buttons + '</div>' +
          packStatsHTML(p) +
          '<div><div class="eyebrow" style="margin-bottom:10px">Top hits · <button class="linkish" data-act="pack-odds" data-id="' + p.id + '">See all top tier</button></div><div class="chase-row">' +
            p.top.slice(0, 6).map(function (c) { return slotHTML(c, { chance: chanceOf(p, c.id) }); }).join('') + '</div></div>' +
        '</div></section>' +
      '<section class="view" style="gap:14px"><div class="section-head"><h2>Choose a pack</h2><span class="muted">Tap a pack to see its top tier</span></div>' +
        '<div class="pack-grid">' + D.PACKS.map(function (x) { return packTileHTML(x, true); }).join('') + '</div></section>' +
      (recent.length ? '<section class="view" style="gap:14px"><div class="section-head"><h2>Your latest pulls</h2><a href="' + link('vault') + '" class="muted">Open vault</a></div><div class="mini-cards">' +
        recent.map(function (h) { return slotHTML(D.cardById[h.id], {}); }).join('') + '</div></section>' : '');
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
    var buyAll = buybackUsd(items.map(function (it) { return D.cardById[it.id]; }));
    var sorts = [['value', 'Highest value'], ['new', 'Newest']];
    return '<section class="section-head"><div><div class="eyebrow">Your cards</div><h2 class="page-title">Vault</h2></div>' +
      '<div class="vault-stats"><div class="stat"><b>' + items.length + '</b><span>Cards</span></div><div class="stat"><b>' + usd(total) + '</b><span>Est. value</span></div><div class="stat"><b>' + buyAll + '</b><span>Buyback now</span></div></div></section>' +
      (items.length
        ? '<div class="section-head"><div class="binder-tabs" role="group" aria-label="Sort">' + sorts.map(function (s) { return '<button class="chip-btn sm" data-act="vsort" data-id="' + s[0] + '" aria-pressed="' + (ui.vaultSort === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div>' +
          '<p class="muted small">Redeeming the physical card opens at launch.</p></div>' +
          '<div class="binder-grid">' + items.map(function (it) {
            var c = D.cardById[it.id];
            return '<div class="slot vault-item"><button data-act="zoom" data-id="' + c.id + '" data-uid="' + it.uid + '" aria-label="' + esc(c.name) + '">' + cardHTML(c) + '</button>' +
              '<div class="slot-cap"><b>' + usd(c.usd) + '</b><span>' + esc(c.code) + '</span></div>' +
              '<button class="btn btn-sm sell" data-act="sell" data-uid="' + it.uid + '"' + (buybackReady() ? '' : ' disabled title="Buyback opens soon"') + '>' + (buybackReady() ? 'Sell back ' + buybackUsd([c]) : 'Buyback soon') + '</button></div>';
          }).join('') + '</div>'
        : '<div class="panel empty">Your vault is empty. <a href="' + link('packs') + '">Open a pack</a> to pull your first card.</div>');
  }

  /* ---------- leaderboard ---------- */
  function ranksHTML() {
    var st = store.state;
    var me = { name: st.user.name, chain: st.user.chain, score: engine.vaultValue(st), cards: st.vault.length, me: true };
    var rows;
    if (ui.leaderboard) {
      rows = ui.leaderboard.map(function (r) { return { name: r.name, chain: r.chain, score: r.score, cards: r.cards, me: r.address === st.user.address && r.chain === st.user.chain }; });
    } else {
      rows = [me];
    }
    rows.sort(function (a, b) { return b.score - a.score; });
    return '<section class="section-head"><div><div class="eyebrow">Vault value</div><h2 class="page-title">Ranks</h2></div><span class="muted small">Ranked by the estimated value of the cards each collector holds</span></section>' +
      '<section class="panel table-scroll" style="padding:8px 12px"><table class="lb"><thead><tr><th>#</th><th>Collector</th><th class="num">Cards</th><th class="num">Vault value</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr' + (r.me ? ' class="me"' : '') + '><td class="rank">' + (i + 1) + '</td><td><div class="who">' + CHAIN_BADGE[r.chain] + '<div><b class="num">' + esc(r.name) + '</b>' + (r.me ? ' <span class="muted">(you)</span>' : '') + '<div class="muted small">' + A.CHAINS[r.chain].name + '</div></div></div></td>' +
          '<td class="num">' + r.cards + '</td><td class="num"><b>' + usd(r.score) + '</b></td></tr>';
      }).join('') + '</tbody></table></section>';
  }

  /* ---------- docs ---------- */
  var X_URL = 'https://x.com/' + D.X_HANDLE;
  var X_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.17h1.7L7.4 4.73H5.58l11.09 14.44Z"/></svg>';
  var DOC_SECTIONS = [
    ['start', 'Getting started'],
    ['packs', 'Packs and prices'],
    ['odds', 'Odds and value'],
    ['token', 'Paying with ' + D.TOKEN],
    ['rng', 'On-chain RNG'],
    ['verify', 'Verify a pack'],
    ['buyback', 'Vault and buyback'],
    ['fees', 'Fees'],
    ['security', 'Wallet safety'],
    ['faq', 'FAQ']
  ];
  // Docs menu: sections grouped, each with a small line icon.
  var DOC_GROUPS = [['Basics', ['start', 'packs', 'odds']], ['Fair play', ['token', 'rng', 'verify']], ['Your cards', ['buyback', 'fees']], ['Help', ['security', 'faq']]];
  var DOC_ICONS = {
    start: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    packs: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 7h14M5 17h14"/>',
    odds: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    token: '<circle cx="12" cy="12" r="9"/><path d="M9 15V9l6 6V9"/>',
    rng: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/>',
    verify: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    buyback: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    fees: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    security: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    faq: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'
  };
  function docMenuHTML() {
    var title = {};
    DOC_SECTIONS.forEach(function (s) { title[s[0]] = s[1]; });
    return '<nav class="doc-toc" aria-label="Docs sections">' + DOC_GROUPS.map(function (g) {
      return '<div class="toc-group"><div class="toc-label">' + esc(g[0]) + '</div>' + g[1].map(function (id) {
        return '<a href="' + link('docs/' + id) + '" data-act="doc-jump" data-to="' + id + '"' + (ui.docActive === id ? ' class="on"' : '') + '>' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' + DOC_ICONS[id] + '</svg><span>' + esc(title[id]) + '</span></a>';
      }).join('') + '</div>';
    }).join('') + '</nav>';
  }
  // Highlights the menu item of the section in view.
  function docSpy() {
    if (ui.route !== 'docs') return;
    var current = DOC_SECTIONS[0][0];
    var toc = $('.doc-toc');
    var line = (toc && root.innerWidth <= 900 ? toc.getBoundingClientRect().bottom : ($('.topbar') ? $('.topbar').offsetHeight : 64)) + 40;
    DOC_SECTIONS.forEach(function (s) { var el = $('#doc-' + s[0]); if (el && el.getBoundingClientRect().top < line) current = s[0]; });
    if ((root.innerHeight + root.scrollY) >= doc.documentElement.scrollHeight - 4) current = DOC_SECTIONS[DOC_SECTIONS.length - 1][0];
    if (current === ui.docActive) return;
    ui.docActive = current;
    var links = doc.querySelectorAll('.doc-toc a');
    for (var i = 0; i < links.length; i++) links[i].classList.toggle('on', links[i].getAttribute('data-to') === current);
    tocToActive();
  }
  // On phones the menu is one scrolling row: keep the active item in view.
  function tocToActive() {
    var toc = $('.doc-toc'), a = $('.doc-toc a.on');
    if (toc && a && root.innerWidth <= 900) toc.scrollLeft = a.getBoundingClientRect().left - toc.getBoundingClientRect().left + toc.scrollLeft - 12;
  }
  function docSec(id, title, body) {
    return '<section class="doc-sec panel" id="doc-' + id + '"><h2>' + title + '</h2>' + body + '</section>';
  }
  function docsHTML() {
    var pct = function (x) { return Math.round(x * 100) + '%'; };
    var BB = pct(D.BUYBACK_RATE);
    var GA = '<code>' + D.GAME_ACCOUNT + '</code>';
    var rarityRows = D.PACKS.map(function (p) {
      var by = {};
      p.pool.forEach(function (e) { var r = D.cardById[e.id].rarity; by[r] = (by[r] || 0) + e.p; });
      return { p: p, by: by };
    });
    var rarities = Object.keys(D.RARITY_INFO).filter(function (r) { return rarityRows.some(function (x) { return x.by[r]; }); });
    var toc = docMenuHTML();
    var secs = [
      docSec('start', 'Getting started',
        '<p>StonkPacks is an on-chain Pokémon TCG gacha on Solana. You open packs of real Pokémon cards, paid in SOL, keep them in your vault, and every card is decided by randomness from the Solana block your payment lands in, which you can check yourself. The StonkPacks token launches on <a href="' + D.LAUNCHPAD.url + '" target="_blank" rel="noopener">' + D.LAUNCHPAD.name + '</a>.</p>' +
        '<ol class="doc-list">' +
          '<li><b>Connect a Solana wallet.</b> Phantom, Solflare or Backpack. You sign one message to prove the wallet is yours. That message is not a transaction and costs nothing.</li>' +
          '<li><b>Pick a pack.</b> Four tiers from ' + usd(D.PACKS[0].usd) + ' to ' + usd(D.PACKS[D.PACKS.length - 1].usd) + '. Every card in the pack and its exact chance is listed before you buy.</li>' +
          '<li><b>Pay in SOL.</b> Your wallet sends one SOL transfer with the pack price to the StonkPacks treasury. The block it lands in decides your card.</li>' +
          '<li><b>Keep your cards.</b> Cards go to your vault and count for the Ranks board. Selling back for ' + BB + ' opens later and will be announced on X.</li>' +
        '</ol>'),
      docSec('packs', 'Packs and prices',
        '<p>Each pack holds one card from a published list of real cards from the Scarlet &amp; Violet era (151, Mega Evolution, Black Bolt and White Flare). Every Pokémon is in exactly one pack, so each pack has its own cards and its own chase hits. Only Pokémon cards are used, one print per Pokémon.</p>' +
        '<div class="table-scroll"><table class="doc-table"><thead><tr><th>Pack</th><th class="num">Price</th><th class="num">Expected value</th><th class="num">Cards</th><th class="num">Card values</th><th class="num">Beat the price</th><th class="num">3× the price</th></tr></thead><tbody>' +
        D.PACKS.map(function (p) {
          return '<tr><td><b>' + esc(p.name) + '</b></td><td class="num">' + usd(p.usd) + '</td><td class="num">' + usd(p.ev) + '</td><td class="num">' + p.pool.length + '</td><td class="num">' + usd(D.cardById[p.pool[p.pool.length - 1].id].usd) + ' – ' + usd(D.cardById[p.pool[0].id].usd) + '</td><td class="num">' + fmtChance(p.beat) + '</td><td class="num">' + fmtChance(p.x3) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="muted small">Prices are in USD and paid in ' + D.TOKEN + '. You can open ' + D.MULTI.join(' or ') + ' at a time; opening 5 is one payment and gives five independent cards.</p>'),
      docSec('odds', 'Odds and value',
        '<p>Every card has a value in USD, estimated from market prices for its rarity and popularity. A card\'s chance falls as its value rises: each card gets a weight of <code>value<sup>−k</sup></code>, and <code>k</code> is solved per pack so the average card is worth exactly <b>' + pct(D.EV_RATIO) + '</b> of the pack price. The remaining ' + pct(1 - D.EV_RATIO) + ' is the house edge.</p>' +
        '<p>The full list, with every card\'s chance, is shown on each pack. The chance of each rarity per pack:</p>' +
        '<div class="table-scroll"><table class="doc-table"><thead><tr><th>Rarity</th>' + D.PACKS.map(function (p) { return '<th class="num">' + esc(p.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rarities.map(function (r) {
          return '<tr><td>' + esc(r) + '</td>' + rarityRows.map(function (x) { return '<td class="num">' + (x.by[r] ? fmtChance(x.by[r]) : '<span class="muted">–</span>') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="muted small">Every pack is independent. There is no pity timer and no hidden adjustment: the odds you see are the odds the code uses, and the randomness comes from the chain.</p>'),
      docSec('token', 'Paying with SOL',
        '<p>Packs are paid in <b>SOL</b>. There are no credits, points or off-chain balances: the balance in the top bar is the SOL in your wallet.</p>' +
        '<ul class="doc-list">' +
          '<li><b>Live price.</b> Packs are priced in USD. When you open one, the SOL amount is taken from the live SOL market price at that moment (median of several exchanges) and locked for that pack, so $10 is always $10 of SOL.</li>' +
          '<li><b>How you pay.</b> One approval, one transaction: a plain SOL transfer from your wallet to ' + (store.game && store.game.treasury ? '<code class="break">' + esc(store.game.treasury) + '</code>' : 'the StonkPacks treasury wallet') + '. No token approvals, no programs to trust.</li>' +
          '<li><b>Exact amount.</b> The site always asks for the exact quoted amount. A payment with a different amount does not open the pack.</li>' +
          '<li><b>Network fee.</b> Solana charges a tiny fee (about 0.000005 SOL) on top of the pack price.</li>' +
        '</ul>'),
      docSec('rng', 'On-chain RNG',
        '<p>Nobody at StonkPacks picks your card, and the server cannot change it after the fact. Each pack opening works like this:</p>' +
        '<ol class="doc-list">' +
          '<li><b>Seed.</b> When you open a pack, the server gives you a one-time 32-byte <code>seed</code>. It is shown in the proof.</li>' +
          '<li><b>Pay.</b> Your wallet sends the SOL transfer. The server never holds your keys and cannot pay for you.</li>' +
          '<li><b>Draw.</b> The randomness is <code>sha256("stonkpacks-sol:v1" || hash of the Solana block that includes your payment || seed)</code>. Nobody knows that block hash before your transaction lands.</li>' +
          '<li><b>Cards.</b> The server checks the transaction on chain (sent by you, exact amount to the treasury, succeeded, sent after the pack started, never used before), computes your cards with the public formula, and your browser computes them again to check.</li>' +
        '</ol>' +
        '<h3>The formula</h3>' +
        '<pre class="doc-code">for i in 0 .. count-1:\n  h   = sha256("stonkpacks-open:v1" || randomness || seed || byte(i))\n  u   = first 6 bytes of h, as an integer / 2^48      // 0 ≤ u &lt; 1\n  card = first card in the pack list whose cumulative chance &gt; u</pre>' +
        '<p class="muted small">The pack list is ordered by value, highest first, as on the pack page. The same code runs in the server and in your browser.</p>'),
      docSec('verify', 'Verify a pack',
        '<p>After every opening the reveal shows a <b>proof</b>, and each card in your vault keeps its own. It contains the pack, the seed, the randomness, the block hash and a Solscan link to your payment.</p>' +
        '<ol class="doc-list">' +
          '<li>Open the transaction on Solscan: it shows your SOL transfer to the treasury and the slot (block) it landed in.</li>' +
          '<li>Your browser already re-ran the formula: <span class="done-txt">✓ Verified in your browser</span> means it got the same cards.</li>' +
          '<li>To check it yourself, take that block\'s hash, compute the randomness and run the formula above with any SHA-256 tool.</li>' +
        '</ol>'),
      docSec('buyback', 'Vault and buyback',
        '<p>Every card you pull goes to your vault with its proof. Your vault value sets your place on the Ranks board.</p>' +
        '<p>Selling a card back for ' + BB + ' of its listed value, paid in SOL, opens later. It will be announced on X.</p>' +
        '<p class="muted small">Card values are estimates and will follow a market price feed.</p>'),
      docSec('fees', 'Fees',
        '<div class="table-scroll"><table class="doc-table"><thead><tr><th>Action</th><th>You pay</th></tr></thead><tbody>' +
          '<tr><td>Connect wallet</td><td>Nothing (message signature)</td></tr>' +
          '<tr><td>Open 1 or 5 packs</td><td>The pack price in SOL, plus the Solana network fee (about 0.000005 SOL)</td></tr>' +
        '</tbody></table></div>'),
      docSec('security', 'Wallet safety',
        '<ul class="doc-list">' +
          '<li>Sign-in is one plain-text message with a one-time code. It never asks for a transaction, approval or seed phrase.</li>' +
          '<li>The only transaction StonkPacks asks for is a SOL transfer of the pack price to the treasury. Check the amount and the address before you approve.</li>' +
          '<li>StonkPacks will never DM you, ask for your seed phrase, or ask you to send SOL or tokens to any other address.</li>' +
          '<li>The token launches only on <a href="' + D.LAUNCHPAD.url + '" target="_blank" rel="noopener">' + D.LAUNCHPAD.name + '</a>. The only official account is <a href="' + X_URL + '" target="_blank" rel="noopener">@' + D.X_HANDLE + '</a> on X.</li>' +
        '</ul>'),
      docSec('faq', 'FAQ',
        [
          ['Can StonkPacks change my card after I open a pack?', 'No. The card follows from the Solana block your payment landed in and the published list. If the server showed a different card, your browser\'s check would fail and the proof would not match.'],
          ['Can StonkPacks see the result before I pay?', 'No. The randomness comes from the hash of the block that includes your payment, which nobody knows before it is produced.'],
          ['What if I reject the transaction or close the page?', 'Nothing is paid. The pack stays unopened: press Continue to pay and open it, or Cancel to drop it.'],
          ['What if I send the wrong amount?', 'The site always asks for the exact quoted amount. A payment with a different amount does not match the pack and opens nothing, so always pay from the site.'],
          ['Why does the SOL amount change?', 'Packs are priced in USD. The SOL amount follows the live SOL market price and is locked when you open the pack.'],
          ['Where does the token launch?', 'On ' + D.LAUNCHPAD.name + ' (' + D.LAUNCHPAD.url + '). The contract address will be posted only by @' + D.X_HANDLE + ' on X.'],
          ['Are the cards physical?', 'Not today. Cards are digital and priced from real market data. Physical redemption may come later and will be announced on X.'],
          ['How strong is the randomness?', 'It comes from the Solana block that includes your payment. A player cannot predict it; in theory a block leader could skip a block, which for card values like these costs far more than it could win.']
        ].map(function (q) { return '<details class="doc-faq"><summary>' + esc(q[0]) + '</summary><p>' + esc(q[1]) + '</p></details>'; }).join(''))
    ];
    return '<section class="section-head"><div><div class="eyebrow">Docs</div><h2 class="page-title">How StonkPacks works</h2></div>' +
      '<a class="btn btn-sm btn-ghost" href="' + X_URL + '" target="_blank" rel="noopener">' + X_SVG + '@' + D.X_HANDLE + '</a></section>' +
      '<div class="docs">' + toc + '<div class="doc-body">' + secs.join('') + '</div></div>';
  }

  /* ---------- admin (interaction wallet only) ----------
     Every change is a transaction nearpacks.near approves in its own wallet: deploy, NEAR pack
     prices, the treasury that receives payments, and the buyback key. The payout key
     is generated in this browser and shown once so it can be pasted into the hosting settings. */
  var ADMIN_KEY_STORE = 'nearpacks:admin-new-key';
  var YOCTO = '000000000000000000000000';
  var STORAGE_DEPOSIT = '12500000000000000000000'; // 0.0125 NEAR in yoctoNEAR
  function adminState() {
    if (!ui.admin) {
      var saved = null;
      try { saved = JSON.parse(root.sessionStorage.getItem(ADMIN_KEY_STORE) || 'null'); } catch (e) { saved = null; }
      ui.admin = { status: null, loading: false, error: null, usd: '', prices: null, newKey: saved, busy: null };
    }
    return ui.admin;
  }
  function loadAdmin() {
    var a = adminState();
    a.loading = true; a.error = null; render();
    return store.adminStatus().then(function (st) {
      a.status = st; a.loading = false;
      render();
    }, function (e) { a.loading = false; a.error = e.message; render(); });
  }
  function adminTx(label, tx) {
    var a = adminState();
    if (a.busy) return;
    a.busy = label; render();
    return W.adminSend(store.state.user, tx).then(function (out) {
      a.busy = null;
      toast(label + ': sent' + (out && out.tx ? ' (' + out.tx.slice(0, 8) + '…)' : '') + '.');
      setTimeout(loadAdmin, 2500);
      return out;
    }, function (e) {
      a.busy = null; render();
      var msg = e && (e.message || String(e)) || '';
      toast(/reject|denied|cancel|closed/i.test(msg) ? label + ' was cancelled in the wallet.' : label + ' failed: ' + msg, true);
    });
  }
  function adminStep(n, done, title, body) {
    return '<section class="panel admin-step' + (done ? ' done' : '') + '"><div class="admin-head"><span class="admin-n">' + (done ? '✓' : n) + '</span><h3>' + title + '</h3>' +
      '<span class="admin-pill ' + (done ? 'ok' : 'todo') + '">' + (done ? 'Done' : 'To do') + '</span></div>' + body + '</section>';
  }
  // Solana admin: payments go straight to the treasury wallet, so there is nothing to deploy.
  function adminSolHTML(a) {
    var st = a.status;
    var head = '<section class="section-head"><div><div class="eyebrow">Treasury wallet</div><h2 class="page-title">Admin</h2></div>' +
      '<button class="btn btn-sm" data-act="admin-refresh"' + (a.loading ? ' disabled' : '') + '>' + (a.loading ? 'Checking…' : 'Refresh') + '</button></section>';
    if (a.error) return head + '<section class="panel err">' + esc(a.error) + '</section>';
    if (!st) return head + '<section class="panel muted">Reading the treasury from Solana…</section>';
    var reason = { treasury: 'No treasury wallet: set TREASURY_SOL on the server.', storage: 'No database connected.', price: 'No SOL price: enter a backup price below.' }[st.reason] || '';
    return head +
      '<section class="panel admin-live' + (st.ready ? '' : ' err') + '"><b>' + (st.ready ? 'Packs are live.' : 'Packs are closed.') + '</b> ' + (st.ready ? 'Players send SOL straight to the treasury.' : esc(reason)) + '</section>' +
      '<section class="panel"><div class="stats">' +
        '<div class="stat"><b>' + (st.treasuryLamports ? fmtToken(st.treasuryLamports, 9) : '—') + '</b><span>SOL in the treasury</span></div>' +
        '<div class="stat"><b>' + (st.usd ? usd(st.usd) : '—') + '</b><span>SOL price now' + (st.priceSource ? ' (' + esc(st.priceSource) + ')' : '') + '</span></div>' +
        '<div class="stat"><b>' + fmt(st.players || 0) + '</b><span>Players</span></div>' +
      '</div><p class="small">Treasury: <code class="break">' + esc(st.treasury || 'not set') + '</code></p></section>' +
      (st.otherChainPlayers ? '<section class="panel"><h3>Old NEAR data</h3><p class="small">' + fmt(st.otherChainPlayers) + ' player' + (st.otherChainPlayers > 1 ? 's' : '') + ' from the NEAR version (incl. nearpacks.near) are still stored. They are hidden from Ranks; delete them for good:</p>' +
        '<button class="btn" data-act="admin-purge"' + (a.busy === 'Purge' ? ' disabled' : '') + '>Delete NEAR players</button></section>' : '') +
      '<section class="panel"><h3>Backup SOL price</h3><p class="muted small">Used only when every live price source fails.</p>' +
        '<div class="admin-form two"><label>USD price of 1 SOL<input id="admin-usd" value="' + esc(st.manualUsd || '') + '" placeholder="150.00" inputmode="decimal" autocomplete="off"></label>' +
        '<button class="btn" data-act="admin-manual-price"' + (a.busy === 'Backup price' ? ' disabled' : '') + '>Save</button></div></section>';
  }

  function adminHTML() {
    if (!store.isAdmin()) return '<section class="panel">The admin page is only for the ' + (D.CHAIN === 'solana' ? 'treasury wallet' : esc(D.ADMIN_ACCOUNTS.join(' and '))) + '.</section>';
    var a = adminState();
    if (D.CHAIN === 'solana') { if (!a.status && !a.loading && !a.error) setTimeout(loadAdmin, 0); return adminSolHTML(a); }
    if (!a.status && !a.loading && !a.error) setTimeout(loadAdmin, 0);
    var st = a.status;
    var head = '<section class="section-head"><div><div class="eyebrow">Interaction wallet</div><h2 class="page-title">Admin</h2></div>' +
      '<button class="btn btn-sm" data-act="admin-refresh"' + (a.loading ? ' disabled' : '') + '>' + (a.loading ? 'Checking…' : 'Refresh') + '</button></section>';
    if (a.error) return head + '<section class="panel err">' + esc(a.error) + '</section>';
    if (!st) return head + '<section class="panel muted">Reading ' + esc(D.GAME_ACCOUNT) + ' from NEAR…</section>';
    var busy = function (label) { return a.busy === label ? ' disabled' : ''; };
    var GA = '<code>' + esc(st.account) + '</code>';
    var me = store.state.user.address;
    var asGame = me === st.account;
    var owner = st.config ? st.config.owner : D.CONTRACT_OWNER;
    var canOwn = asGame || me === owner;
    var needGame = '<p class="small">This step changes ' + GA + ' itself, so log in as <b>' + esc(st.account) + '</b> to do it.</p>';
    var needOwner = '<p class="small">Log in as the contract owner <b>' + esc(owner) + '</b> or as ' + GA + ' to do this.</p>';
    var modeLine = st.ready
      ? '<section class="panel admin-live ok"><b>Packs are live.</b> ' + (st.mode === 'contract'
          ? 'Players pay through the StonkPacks contract on ' + esc(st.account) + '; payments go to ' + esc((st.config && st.config.treasury) || D.TREASURY) + '.'
          : 'Players send NEAR straight to ' + esc(st.directTreasury) + ' (direct mode). Deploy the contract below to turn on buybacks.') + '</section>'
      : '<section class="panel admin-live"><b>Packs are not open yet.</b> They open as soon as a NEAR price is available (step 2).</section>';
    var summary = modeLine + '<section class="panel admin-summary">' +
      '<div class="stat"><b>' + (st.near ? fmtToken(st.near, 24) : '—') + '</b><span>NEAR on ' + esc(st.account) + ' (buybacks)</span></div>' +
      '<div class="stat"><b>' + (st.treasury && st.treasury.near ? fmtToken(st.treasury.near, 24) : '—') + '</b><span>NEAR on ' + esc(D.TREASURY) + ' (payments)</span></div>' +
      '<div class="stat"><b>' + (st.nearUsd ? usd(st.nearUsd) : '—') + '</b><span>NEAR price now</span></div></section>';

    // 1. Contract
    var cli = 'near deploy ' + st.account + ' nearpacks_game.wasm --initFunction new --initArgs \'{"owner":"' + D.CONTRACT_OWNER + '","treasury":"' + D.TREASURY + '","prices":null}\'';
    var s1 = adminStep(1, st.initialized, 'StonkPacks contract on ' + esc(st.account) + ' (for on-chain draws and buybacks)',
      st.initialized ? '<p class="muted small">Deployed and initialized. Owner ' + esc(st.config.owner) + '.</p>'
        : !asGame ? needGame : (st.deployed
          ? '<p class="small">Code is deployed but not initialized.</p><button class="btn btn-gold" data-act="admin-init"' + busy('Initialize') + '>Initialize contract</button>'
          : '<p class="small">Deploys the StonkPacks contract to ' + GA + ' and initializes it, in one transaction your wallet approves. Your NEAR and tokens stay in the account.</p>' +
            '<button class="btn btn-gold" data-act="admin-deploy"' + busy('Deploy') + '>Deploy with wallet</button>' +
            '<p class="muted small">Some wallets cannot deploy contracts from a website. If yours refuses, run this once with NEAR CLI (logged in as ' + esc(st.account) + '), using <a href="contracts/near-rng/res/nearpacks_game.wasm" download>nearpacks_game.wasm</a>:</p><pre class="doc-code">' + esc(cli) + '</pre>'));

    // 2. Live NEAR price (packs stay at their USD price)
    var quote = st.nearUsd ? D.PACKS.map(function (p) { return esc(p.name.replace(' Pack', '')) + ' ' + usd(p.usd) + ' ≈ ' + (p.usd / st.nearUsd).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ' NEAR'; }).join(' · ') : '';
    var src = st.priceSource === 'manual' ? 'your backup price (live sources unreachable)' : st.priceSource === 'contract' ? 'fixed prices on the contract' : st.priceSource ? 'live market (' + esc(st.priceSource) + ')' : null;
    var s2 = adminStep(2, Boolean(st.ready), 'Live NEAR price',
      (st.nearUsd ? '<p class="small">1 NEAR = <b>' + usd(st.nearUsd) + '</b> from ' + src + '. Every pack is quoted at the price of that moment.</p><p class="muted small">' + quote + '</p>'
        : '<p class="small err">No NEAR price yet: the live sources did not answer. Enter a backup price below so packs can open.</p>') +
      '<div class="admin-form two"><label>Backup USD price of 1 NEAR (used only if live sources fail)<input id="admin-usd" value="' + esc(st.manualNearUsd || '') + '" placeholder="2.50" inputmode="decimal" autocomplete="off"></label>' +
      '<button class="btn" data-act="admin-manual-price"' + busy('Backup price') + '>Save backup</button></div>');

    // 3. Treasury
    var cfg = st.config;
    var tre = cfg && cfg.treasury;
    var s3 = adminStep(3, st.initialized ? tre === D.TREASURY : st.directTreasury === D.TREASURY, 'Payments go to ' + esc(D.TREASURY),
      !st.initialized ? '<p class="muted small">Direct mode: players send NEAR straight to <code>' + esc(st.directTreasury) + '</code>. After the contract is deployed it forwards every payment there.</p>'
        : tre === D.TREASURY ? '<p class="muted small">Every pack payment is forwarded to <code>' + esc(tre) + '</code> in the same transaction' + (st.treasury && st.treasury.exists === false ? '. <b class="err">That account does not exist on NEAR yet; payments would fail.</b>' : '.') + '</p>'
        : '<p class="small">The contract sends payments to <code>' + esc(tre || '?') + '</code>. Switch it to <code>' + esc(D.TREASURY) + '</code>:</p>' + (canOwn ? '<button class="btn btn-gold" data-act="admin-treasury"' + busy('Set treasury') + '>Set treasury with wallet</button>' : needOwner));

    // 4. Buyback key
    var pk = st.payoutKey;
    var keyDone = pk.configured && pk.onChain;
    var nk = a.newKey;
    var s4body;
    if (keyDone) {
      s4body = '<p class="muted small">Buyback is on. Key ' + esc(pk.publicKey) + ' can only call payout() on ' + esc(st.account) + '.</p>';
    } else if (pk.configured && !pk.onChain) {
      s4body = '<p class="small">The server has a PAYOUT_KEY (' + esc(pk.publicKey || '?') + ') but it is not on ' + GA + ' yet.</p>' +
        '<button class="btn btn-gold" data-act="admin-addkey" data-key="' + esc(pk.publicKey || '') + '"' + busy('Add buyback key') + '>Add this key with wallet</button>';
    } else if (nk) {
      s4body = '<p class="small"><b>1.</b> Copy this secret key now and add it to your hosting as the environment variable <code>PAYOUT_KEY</code>. It is shown only in this browser tab and is never sent anywhere.</p>' +
        '<div class="ref-row"><input id="admin-secret" readonly value="' + esc(nk.secret) + '" aria-label="Payout secret key"><button class="btn" data-act="admin-copy">Copy</button></div>' +
        '<p class="small"><b>2.</b> Allow it on ' + GA + ' (it can only call payout, with at most 1 NEAR of gas):</p>' +
        '<button class="btn btn-gold" data-act="admin-addkey" data-key="' + esc(nk.publicKey) + '"' + busy('Add buyback key') + '>Add key with wallet</button>' +
        '<p class="small"><b>3.</b> Redeploy the server, then press Refresh. When the server sees the key this step turns green.</p>' +
        '<button class="btn btn-ghost btn-sm" data-act="admin-forget">I saved it, hide the secret</button>';
    } else {
      s4body = '<p class="small">Buybacks are paid in NEAR by ' + GA + ' through a key that can only call payout(). Keep some NEAR on ' + GA + ' for them. Generate the key here; it is created in this browser.</p>' +
        '<button class="btn btn-gold" data-act="admin-genkey">Generate buyback key</button>';
    }
    if (!keyDone && !asGame) s4body = '<p class="small">Buybacks are paid in NEAR by ' + GA + ' through a key that can only call payout().</p>' + needGame;
    var s4 = adminStep(4, keyDone, 'Buyback key (PAYOUT_KEY)', s4body);
    return head + summary + '<div class="admin-steps">' + s1 + s2 + s3 + s4 + '</div>';
  }
  function adminCalc() {
    var a = adminState();
    a.usd = ($('#admin-usd') || {}).value ? $('#admin-usd').value.trim().replace(',', '.') : '';
    a.prices = D.packPricesRaw(a.usd, 24);
    if (!a.prices) toast('Enter the USD price of 1 NEAR, for example 2.50.', true);
    render();
  }
  function adminAction(act, el) {
    var a = adminState();
    var st = a.status;
    var GA = st && st.account;
    switch (act) {
      case 'admin-refresh': loadAdmin(); break;
      case 'admin-calc': adminCalc(); break;
      case 'admin-deploy':
        a.busy = 'Deploy'; render();
        fetch('contracts/near-rng/res/nearpacks_game.wasm').then(function (r) {
          if (!r.ok) throw new Error('Could not load the contract file.');
          return r.arrayBuffer();
        }).then(function (buf) {
          a.busy = null;
          return adminTx('Deploy', { receiverId: GA, actions: [
            { type: 'deploy', code: new Uint8Array(buf) },
            { type: 'call', method: 'new', args: { owner: D.CONTRACT_OWNER, treasury: D.TREASURY, prices: null }, gas: '100000000000000' }
          ] });
        }).catch(function (e) { a.busy = null; render(); toast(e.message, true); });
        break;
      case 'admin-init':
        adminTx('Initialize', { receiverId: GA, actions: [{ type: 'call', method: 'new', args: { owner: D.CONTRACT_OWNER, treasury: D.TREASURY, prices: null } }] });
        break;
      case 'admin-purge':
        if (!root.confirm('Delete every NEAR player, their vaults and sessions? This cannot be undone.')) break;
        a.busy = 'Purge'; render();
        store.adminPurge().then(function (r) { a.busy = null; toast('Deleted ' + r.players + ' NEAR player' + (r.players === 1 ? '' : 's') + '.'); loadAdmin(); }, function (e) { a.busy = null; render(); toast(e.message, true); });
        break;
      case 'admin-manual-price':
        var v = (($('#admin-usd') || {}).value || '').trim().replace(',', '.');
        if (v && !D.packPricesRaw(v, D.TOKEN_DECIMALS)) { toast('Enter the USD price of 1 ' + D.TOKEN + ', for example ' + (D.CHAIN === 'solana' ? '150.25' : '2.50') + '.', true); break; }
        a.busy = 'Backup price'; render();
        store.adminSetPrice(v).then(function () { a.busy = null; toast(v ? 'Backup price saved.' : 'Backup price cleared.'); loadAdmin(); }, function (e) { a.busy = null; render(); toast(e.message, true); });
        break;
      case 'admin-save-prices':
        if (!a.prices) return;
        adminTx('Save prices', { receiverId: GA, actions: [{ type: 'call', method: 'set_prices', args: { prices: a.prices } }] });
        break;
      case 'admin-treasury':
        adminTx('Set treasury', { receiverId: GA, actions: [{ type: 'call', method: 'set_treasury', args: { treasury: D.TREASURY } }] });
        break;
      case 'admin-genkey':
        W.adminKeyPair().then(function (k) {
          a.newKey = k;
          try { root.sessionStorage.setItem(ADMIN_KEY_STORE, JSON.stringify(k)); } catch (e) { /* tab memory only */ }
          render();
        }, function (e) { toast(e.message, true); });
        break;
      case 'admin-copy':
        var inp = $('#admin-secret');
        try { navigator.clipboard.writeText(inp.value).then(function () { toast('Secret key copied. Paste it as PAYOUT_KEY in your hosting.'); }); } catch (e) { inp.select(); toast('Press Ctrl+C or Cmd+C to copy.'); }
        break;
      case 'admin-addkey':
        adminTx('Add buyback key', { receiverId: GA, actions: [{ type: 'addKey', publicKey: el.getAttribute('data-key'), receiverId: GA, methods: ['payout'], allowance: '1' + YOCTO }] });
        break;
      case 'admin-forget':
        a.newKey = null;
        try { root.sessionStorage.removeItem(ADMIN_KEY_STORE); } catch (e) { /* ignore */ }
        render();
        break;
    }
  }

  /* ---------- main render ---------- */
  function render() {
    var st = store.state;
    var body;
    if (ui.route === 'docs') body = docsHTML();
    else if (!st.user) body = landingHTML();
    else if (ui.route === 'admin') body = adminHTML();
    else if (ui.route === 'vault') body = vaultHTML();
    else if (ui.route === 'ranks') body = ranksHTML();
    else body = packsHTML();
    $('#app').innerHTML = topbarHTML() + '<main><div class="wrap view">' + body + '</div></main>' + footerHTML();
    syncTopbar();
    if (ui.route === 'docs') tocToActive();
  }
  // The top bar wraps to two rows on phones; sticky menus sit right under it.
  function syncTopbar() {
    var bar = $('.topbar');
    if (bar) doc.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }

  /* Clean URLs (/packs, /docs/rng); #packs only in previews that set PN_CONFIG.hashUrls. */
  function cleanUrls() { return !(root.PN_CONFIG && root.PN_CONFIG.hashUrls) && root.location.protocol !== 'file:' && !!(root.history && root.history.pushState); }
  function link(path) { return cleanUrls() ? '/' + path : '#' + path; }
  function routeParts() {
    if (!cleanUrls()) return (root.location.hash || '').replace('#', '').split('/');
    var h = (root.location.hash || '').replace('#', '');
    if (h && ROUTES.indexOf(h.split('/')[0]) >= 0) { root.history.replaceState(null, '', '/' + h); return h.split('/'); } // old #links
    return root.location.pathname.split('/').filter(Boolean);
  }
  function navigate(path) {
    if (!cleanUrls()) { root.location.hash = path; return; }
    root.history.pushState(null, '', '/' + path);
    setRoute();
  }
  // Same-site links move with pushState instead of a page load.
  function onLink(e) {
    if (!cleanUrls() || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a[href^="/"]');
    if (!a || a.target || a.hasAttribute('data-act')) return;
    e.preventDefault();
    if (a.getAttribute('href') !== root.location.pathname) root.history.pushState(null, '', a.getAttribute('href'));
    setRoute();
  }

  function setRoute() {
    var parts = routeParts();
    var h = parts[0];
    ui.route = ROUTES.indexOf(h) >= 0 ? h : 'packs';
    if ($('#modal') && $('#modal').innerHTML) closeModal();
    if (ui.route === 'ranks' && store.mode === 'live') {
      store.leaderboard().then(function (rows) { ui.leaderboard = rows; render(); }).catch(function () { ui.leaderboard = null; });
    }
    render();
    var sec = h === 'docs' && parts[1] && $('#doc-' + parts[1]);
    if (sec) sec.scrollIntoView();
    else root.scrollTo(0, 0);
    ui.docActive = null;
    docSpy();
  }

  /* ---------- modals ---------- */
  // Wallet picker: Solana wallets in this browser (or NEAR wallets on a NEAR site, loaded on demand).
  function openConnect() {
    if (D.CHAIN === 'solana') return renderConnectSol();
    ui.nearList = null;
    renderConnect();
    W.nearWallets().then(function (list) { ui.nearList = list; if ($('#wallet-modal')) renderConnect(); })
      .catch(function (err) { ui.nearList = { error: err.message }; if ($('#wallet-modal')) renderConnect(); });
  }
  function renderConnectSol() {
    var rows = W.solanaWallets().map(function (w) {
      var action = w.installed
        ? '<button class="btn btn-sm btn-gold" data-act="wallet-sol" data-id="' + esc(w.id) + '" data-name="' + esc(w.name) + '">Connect</button>'
        : w.openUrl ? '<a class="btn btn-sm" href="' + esc(w.openUrl) + '">Open in app</a>'
        : '<a class="btn btn-sm" href="' + esc(w.install) + '" target="_blank" rel="noopener">Install</a>';
      return '<li class="wallet-row">' + (w.icon ? '<img class="wallet-ico" src="' + w.icon + '" alt="">' : '<span class="wallet-ico">' + esc(w.name[0]) + '</span>') +
        '<span class="wallet-name">' + esc(w.name) + '</span>' + action + '</li>';
    }).join('');
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><div class="modal wallet-modal" id="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">' +
      '<div class="modal-title">' + WALLET_SVG + '<h2 id="connect-title">Connect wallet</h2></div>' +
      '<p class="muted small">StonkPacks runs on Solana. Sign one message to prove you own the wallet. It does not send a transaction or cost any fee.</p>' +
      '<section><div class="eyebrow">' + CHAIN_BADGE.solana + ' Solana</div><ul class="wallet-list">' + rows + '</ul></section>' +
      '<div class="err" id="connect-err" role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">Cancel</button></div>' +
      '</div></div>';
  }
  function renderConnect() {
    var near;
    if (!ui.nearList) near = '<li class="wallet-row muted small">Loading NEAR wallets…</li>';
    else if (ui.nearList.error) near = '<li class="wallet-row"><span class="err">' + esc(ui.nearList.error) + '</span></li>';
    else near = ui.nearList.map(function (w) {
      return '<li class="wallet-row">' + (w.iconUrl ? '<img class="wallet-ico" src="' + esc(w.iconUrl) + '" alt="">' : '<span class="wallet-ico">' + esc(w.name[0]) + '</span>') +
        '<span class="wallet-name">' + esc(w.name) + '</span>' +
        '<button class="btn btn-sm' + (w.available ? ' btn-gold' : '') + '" data-act="wallet-near" data-id="' + esc(w.id) + '" data-name="' + esc(w.name) + '"' + (w.available ? '' : ' disabled title="Not available in this browser"') + '>' + (w.available ? 'Connect' : 'Unavailable') + '</button></li>';
    }).join('');
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><div class="modal wallet-modal" id="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">' +
      '<div class="modal-title">' + WALLET_SVG + '<h2 id="connect-title">Connect wallet</h2></div>' +
      '<p class="muted small">StonkPacks runs on NEAR. Sign one message to prove you own the wallet. It does not send a transaction or cost any fee.</p>' +
      '<section><div class="eyebrow">' + CHAIN_BADGE.near + ' NEAR</div><ul class="wallet-list">' + near + '</ul></section>' +
      '<div class="err" id="connect-err" role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">Cancel</button></div>' +
      '</div></div>';
  }

  function signIn(chain, signer, label) {
    var err = $('#connect-err');
    if (!signer) { if (err) err.textContent = label + ' was not found in this browser.'; return; }
    if (err) err.textContent = 'Approve the sign-in in ' + label + '…';
    store.connectWallet(chain, signer).then(function (r) {
      $('#modal').innerHTML = '';
      navigate('packs');
      var u = store.state.user;
      toast('Welcome ' + u.name + '!');
      refreshBalance();
    }).catch(function (e) {
      var el = $('#connect-err');
      var msg = e && (e.message || String(e));
      if (/reject|denied|cancel|closed/i.test(msg || '')) msg = 'Sign-in was cancelled in the wallet.';
      if (el) el.textContent = msg || 'Sign-in failed. Try again.'; else toast(msg || 'Sign-in failed. Try again.', true);
    });
  }

  function openZoom(id, uid) {
    var item = uid && store.state.vault ? store.state.vault.filter(function (it) { return it.uid === uid; })[0] : null;
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
      ['Instant buyback', buybackUsd([card]) + ' in ' + D.TOKEN],
      ['Chance', inPacks.length ? inPacks.join(' · ') : 'Not in any pack yet'],
      ['In your vault', held ? '×' + held : 'Not yet']
    ];
    if (card.illus) rows.splice(3, 0, ['Illustrator', card.illus]);
    var best = D.PACKS.filter(function (p) { return chanceOf(p, id) > 0; })[0];
    $('#modal').innerHTML = '<div class="modal-back" data-act="close-modal"><div class="modal zoom" role="dialog" aria-modal="true" aria-label="' + esc(card.name) + '">' +
      '<div class="zoom-card">' + cardHTML(card) + '</div>' +
      '<div class="zoom-info"><div class="eyebrow">Pokémon TCG</div><h2>' + esc(card.name) + '</h2>' +
      '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
      (item && item.proof ? '<div class="eyebrow">How this card was pulled</div>' + proofSingleHTML(item) : '') +
      '<div class="modal-actions" style="justify-content:start">' + (best && store.state.user ? '<button class="btn btn-gold" data-act="go-pack" data-id="' + best.id + '">Open the ' + esc(best.name) + '</button>' : '') + '<button class="btn btn-ghost" data-act="close-modal">Close</button></div></div>' +
      '</div></div>';
  }
  function closeModal() { $('#modal').innerHTML = ''; }

  // Proof for one vault item: re-derive the whole rip and check this card's position.
  function proofSingleHTML(item) {
    var pr = item.proof;
    var group = store.state.vault.filter(function (it) { return it.proof && it.proof.seed === pr.seed; });
    var n = Math.max(group.length, (item.n || 0) + 1);
    var expected = engine.cardsFromRandomness(item.pack, n, pr.randomness, pr.seed)[item.n || 0];
    return proofHTML(pr, [item.id], item.pack, 1).replace(/class="proof-(ok|bad)">[^<]*</, expected && expected.id === item.id ? 'class="proof-ok">✓ Verified in your browser<' : 'class="proof-bad">✗ Does not match<');
  }

  /* ---------- rip ---------- */
  /* A rip: reserve a seed -> pay in NEAR from the player's wallet (the contract draws the
     randomness in that transaction) -> server reads the draw -> cards. */
  function startRip(count) {
    if (ui.busy) return;
    if (store.state.pendingRip) { resumeRip(); return; }
    ui.busy = true;
    store.ripStart(ui.pack, count).then(function (rip) {
      ui.busy = false;
      beginRandomness(rip, false);
    }).catch(function (e) { ui.busy = false; toast(e.message || 'Could not open the pack.', true); });
  }

  function resumeRip() {
    var pr = store.state.pendingRip;
    if (pr) beginRandomness(pr, true);
  }

  function rngSourceName(user) {
    if (store.mode !== 'live') return 'On-chain randomness';
    if (store.isDev()) return 'Owner opening · ' + user.address;
    if (D.CHAIN === 'solana') return 'Paid in SOL · block randomness';
    return 'Paid on NEAR · ' + D.GAME_ACCOUNT;
  }

  function beginRandomness(rip, resuming) {
    ui.opening = { pack: rip.pack, count: rip.count, rip: rip, stage: 'chain', status: 'wallet', error: null, revealed: {}, sold: {} };
    renderOverlay();
    if (store.mode !== 'live') { ui.opening.status = 'waiting'; renderOverlay(); setTimeout(function () { pollRip(0); }, 900); return; }
    if (store.devResult && !resuming) {
      var dev = store.devResult;
      store.devResult = null;
      ui.opening.status = 'waiting';
      renderOverlay();
      setTimeout(function () { if (ui.opening) deliverRip(dev); }, 700);
      return;
    }
    if (resuming) {
      // The request may already be on chain: check first, ask the wallet only if nothing is there.
      ui.opening.status = 'checking';
      renderOverlay();
      var returnedTx = ui.returnedTx;
      ui.returnedTx = null;
      store.ripFinish(returnedTx ? { tx: returnedTx } : {}).then(function (r) {
        if (!ui.opening) return;
        if (!r.pending) return deliverRip(r);
        if (r.status === 'pending') { ui.opening.status = 'waiting'; renderOverlay(); return pollRip(0); }
        return askWallet();
      }).catch(ripError);
      return;
    }
    askWallet();
  }

  function askWallet() {
    var o = ui.opening;
    o.status = 'wallet';
    o.error = null;
    renderOverlay();
    W.payRip(store.state.user, store.pay).then(function (out) {
      if (!ui.opening) return;
      ui.opening.tx = out.tx;
      ui.opening.status = 'waiting';
      renderOverlay();
      pollRip(0);
    }).catch(function (e) {
      var msg = e && (e.message || String(e)) || '';
      if (/already drawn/i.test(msg)) { ui.opening.status = 'waiting'; renderOverlay(); return pollRip(0); }
      ripError(e);
    });
  }

  function pollRip(tries) {
    if (!ui.opening || ui.opening.stage !== 'chain') return;
    store.ripFinish({ tx: ui.opening.tx || null }).then(function (r) {
      if (!ui.opening) return;
      if (r.pending) {
        if (tries >= 80) { ui.opening.status = 'slow'; renderOverlay(); return; }
        setTimeout(function () { pollRip(tries + 1); }, 1500);
        return;
      }
      deliverRip(r);
    }).catch(ripError);
  }

  function deliverRip(r) {
    refreshBalance();
    var o = ui.opening;
    o.items = r.items;
    o.proof = r.proof;
    o.stage = 'pack';
    renderOverlay();
  }

  function ripError(e) {
    if (!ui.opening) return toast(e.message || 'Something went wrong.', true);
    var msg = e && (e.message || String(e)) || 'Something went wrong.';
    if (/reject|denied|cancel|closed|declined/i.test(msg)) msg = 'The payment was cancelled in your wallet. Nothing was paid.';
    ui.opening.status = 'error';
    ui.opening.error = msg;
    renderOverlay();
  }

  // Proof box: where the randomness came from, links, and a local re-derivation check.
  function proofHTML(proof, ids, packId, count) {
    if (!proof) return '';
    var check = engine.cardsFromRandomness(packId, count, proof.randomness, proof.seed).map(function (c) { return c.id; });
    var ok = ids.length === check.length && ids.every(function (id, i) { return id === check[i]; });
    var src = proof.source === 'sol-transfer' ? 'Paid in SOL to ' + short(proof.ref || '') + ' · block randomness' : proof.source === 'near-transfer' ? 'Paid to ' + (proof.ref || D.TREASURY) + ' · block randomness' : proof.source === 'nearpacks-near' || proof.source === 'near-rng' ? 'Paid on NEAR · ' + (proof.ref || D.GAME_ACCOUNT) : proof.source === 'dev' ? 'Owner opening · server randomness, not paid' : proof.source === 'orao-vrf' ? 'ORAO VRF · Solana' : 'Off-chain randomness';
    var ex = W.explorer(proof, CFG.nearNetwork);
    var links = ex ? (ex.tx ? '<a href="' + esc(ex.tx) + '" target="_blank" rel="noopener">Transaction on ' + ex.label + '</a>' : '') +
      (ex.account ? '<a href="' + esc(ex.account) + '" target="_blank" rel="noopener">' + (proof.source === 'near-transfer' ? 'Treasury' : 'Interaction wallet') + '</a>' : '') : '';
    return '<div class="proof"><div class="proof-head"><span class="proof-src">' + esc(src) + '</span>' +
      '<span class="' + (ok ? 'proof-ok' : 'proof-bad') + '">' + (ok ? '✓ Verified in your browser' : '✗ Does not match') + '</span></div>' +
      '<dl><dt>Seed</dt><dd class="num">' + esc(proof.seed) + '</dd><dt>Randomness</dt><dd class="num">' + esc(proof.randomness) + '</dd></dl>' +
      (links ? '<div class="proof-links">' + links + '</div>' : '') + '</div>';
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
    if (o.stage === 'chain') {
      var u = store.state.user;
      var live = store.mode === 'live' && !store.isDev();
      var walletName = u.wallet || A.CHAINS[u.chain].name;
      var pay = store.pay;
      var direct = !!(pay && (pay.method === 'transfer' || pay.method === 'sol-transfer'));
      var tok = D.TOKEN;
      var steps = [
        [o.status === 'wallet' || o.status === 'checking' ? 'active' : o.status === 'error' ? 'error' : 'done',
          live ? 'Pay ' + usd(p.usd * o.count) + (pay && pay.deposit ? ' = ' + fmtNear(pay.deposit) + ' ' + tok : ' in ' + tok) : store.isDev() ? 'Owner wallet: free, no payment' : 'Pay in ' + tok,
          live ? (o.status === 'checking' ? 'Checking the chain for your payment…' : 'Approve one ' + (direct ? 'transfer to ' + esc(short(pay.receiver)) : 'transaction to ' + D.GAME_ACCOUNT) + ' in ' + esc(walletName) + ' (plus a tiny network fee). Price from the live ' + tok + ' market.') : store.isDev() ? 'Packs opened by ' + esc(u.address) + ' are free and recorded as owner openings' : 'This preview is not connected to a chain'],
        [o.status === 'waiting' || o.status === 'slow' ? 'active' : 'todo', 'Randomness drawn on chain',
          o.status === 'slow' ? 'Taking longer than usual. Your pack is saved; check again in a moment.' : (live ? (direct ? 'From the hash of the block that includes your payment' : 'The ' + D.GAME_ACCOUNT + ' contract draws it in the same transaction') : store.isDev() ? 'Server randomness' : 'Browser randomness')]
      ];
      var actions = '';
      if (o.status === 'error') {
        actions = '<button class="btn btn-gold" data-act="rip-retry">Try again</button><button class="btn" data-act="rip-refund">Cancel</button><button class="btn btn-ghost" data-act="rip-later">Later</button>';
        if (live && direct) actions += '<div class="tx-paste"><span class="muted small">Already paid? Paste the transaction ' + (D.CHAIN === 'solana' ? 'signature' : 'hash') + ':</span><div class="ref-row"><input id="rip-tx" placeholder="Transaction ' + (D.CHAIN === 'solana' ? 'signature' : 'hash') + '" autocomplete="off"><button class="btn" data-act="rip-tx">Check</button></div><span class="muted small">Cancel only if you did not pay: a payment sent for a cancelled pack cannot be matched.</span></div>';
      } else if (o.status === 'slow') {
        actions = '<button class="btn btn-gold" data-act="rip-check">Check again</button><button class="btn btn-ghost" data-act="rip-later">Later</button>';
      }
      html = '<div class="open-stage chain-stage"><div class="eyebrow">' + esc(p.name) + ' · ' + o.count + ' card' + (o.count > 1 ? 's' : '') + ' · ' + esc(rngSourceName(u)) + '</div>' +
        '<div class="chain-pack">' + packArtHTML(p) + '</div>' +
        '<h2>' + (o.status === 'error' ? 'Payment not sent' : live ? 'Paying and drawing on chain' : 'Drawing your cards') + '</h2>' +
        '<ol class="chain-steps">' + steps.map(function (st) {
          return '<li class="cs ' + st[0] + '"><span class="cs-dot" aria-hidden="true">' + (st[0] === 'done' ? '✓' : st[0] === 'error' ? '!' : '') + '</span><div><b>' + st[1] + '</b><small>' + st[2] + '</small></div></li>';
        }).join('') + '</ol>' +
        (o.error ? '<p class="err" role="alert">' + esc(o.error) + '</p>' : '') +
        '<p class="muted small seed-line">Pack seed <span class="num">' + esc(o.rip.seed.slice(0, 16)) + '…</span></p>' +
        (actions ? '<div class="open-actions">' + actions + '</div>' : '') + '</div>';
    } else if (o.stage === 'pack') {
      html = '<div class="open-stage"><div class="eyebrow">' + esc(p.name) + ' · ' + o.items.length + ' card' + (o.items.length > 1 ? 's' : '') + '</div>' +
        '<button class="big-pack" data-act="tear" aria-label="Tear open the pack">' + packArtHTML(p) + '</button>' +
        '<h2>Tap the pack to open it</h2></div>';
    } else {
      var all = allRevealed();
      var grid = o.items.map(function (it, i) {
        var card = D.cardById[it.id];
        var t = rar(card.tier);
        var hint = card.usd >= p.usd ? ' hint-UR' : t.rank >= rar('SR').rank ? ' hint-SR' : '';
        var sold = o.sold[it.uid];
        var below = all
          ? '<div class="rip-cap' + (card.usd >= p.usd ? ' win' : '') + '"><b>' + usd(card.usd) + '</b><span>' + esc(card.code) + '</span></div>' +
            (sold ? '<div class="sold-tag">Sold for ' + buybackUsd([card]) + '</div>'
              : '<button class="btn btn-sm sell" data-act="sell-rip" data-uid="' + it.uid + '"' + (buybackReady() ? '' : ' disabled') + '>' + (buybackReady() ? 'Sell back ' + buybackUsd([card]) : 'Buyback soon') + '</button>')
          : '';
        return '<div class="rip-slot"><button class="flip' + hint + (o.revealed[i] ? ' revealed' : '') + (sold ? ' sold' : '') + '" data-act="flip" data-i="' + i + '" style="animation-delay:' + (i * 80) + 'ms" aria-label="' + (o.revealed[i] ? esc(card.name + ', ' + card.rarity) : 'Reveal card ' + (i + 1)) + '">' +
          '<div class="flip-inner"><div class="face back"><div class="card-back"><img src="assets/brand/stonkpacks-icon.svg" alt=""></div></div><div class="face front">' + cardHTML(card) + '</div></div></button>' + below + '</div>';
      }).join('');
      var summary = '', actions;
      if (all) {
        var total = o.items.reduce(function (n, it) { return n + D.cardById[it.id].usd; }, 0);
        var spent = p.usd * o.items.length;
        var best = o.items.slice().sort(function (a, b) { return D.cardById[b.id].usd - D.cardById[a.id].usd; })[0];
        var bestCard = D.cardById[best.id];
        var unsold = o.items.filter(function (it) { return !o.sold[it.uid]; });
        summary = '<div class="summary"><span>Pulled <b>' + usd(Math.round(total * 100) / 100) + '</b> for <b>' + usd(spent) + '</b></span>' +
          '<span class="' + (total >= spent ? 'up' : 'down') + '">' + (total >= spent ? '+' : '−') + usd(Math.abs(Math.round((total - spent) * 100) / 100)) + '</span></div>';
        summary += proofHTML(o.proof, o.items.map(function (it) { return it.id; }), o.pack, o.items.length);
        actions = (unsold.length > 1 && buybackReady() ? '<button class="btn" data-act="sell-all-rip">Sell back all · ' + buybackUsd(unsold.map(function (it) { return D.cardById[it.id]; })) + '</button>' : '') +
          '<button class="btn btn-gold" data-act="again"' + (payReady() ? '' : ' disabled') + '>Open again · ' + usd(p.usd * o.count) + '</button>' +
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

  function soldToast(r) {
    toast('Sold back for ' + usd(r.usd) + (r.payout && r.payout.amount ? ', paid in ' + D.TOKEN + ' to your wallet.' : r.payout && r.payout.dev ? ' (dev wallet, recorded only).' : '.'));
    refreshBalance();
  }
  function sell(uids, onDone) {
    run(function () { return store.buyback(uids); }, function (r) { if (onDone) onDone(r); soldToast(r); });
  }
  function sellFromRip(uids) {
    sell(uids, function () {
      uids.forEach(function (u) { ui.opening.sold[u] = true; });
      renderOverlay();
    });
  }

  // On-chain NEAR balance for the top bar (live mode).
  function refreshBalance() {
    store.balance().then(function (b) { ui.balance = b; if (!ui.opening) render(); });
  }

  /* ---------- events ---------- */
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    var uid = Number(el.getAttribute('data-uid'));
    if (act.indexOf('admin-') === 0) { adminAction(act, el); return; }
    switch (act) {
      case 'connect': openConnect(); break;
      case 'wallet-sol': signIn('solana', W.solanaSigner(id), el.getAttribute('data-name')); break;
      case 'wallet-near': signIn('near', W.nearSigner(id, el.getAttribute('data-name')), el.getAttribute('data-name')); break;
      case 'close-modal': if (e.target === el || el.tagName === 'BUTTON') closeModal(); break;
      case 'logout': store.logout().then(function () { toast('Logged out.'); }); break;
      case 'doc-jump':
        e.preventDefault();
        var ds = $('#doc-' + el.getAttribute('data-to'));
        if (ds) ds.scrollIntoView({ behavior: 'smooth' });
        try { root.history.replaceState(null, '', link('docs/' + el.getAttribute('data-to'))); } catch (err) { /* ignore */ }
        break;
      case 'scroll-rates': e.preventDefault(); var r = $('#rates'); if (r) r.scrollIntoView({ behavior: 'smooth' }); break;
      case 'pack':
        if ($('.pull-stage')) { ui.pack = id; render(); }
        openPackOdds(D.packById[id]); break;
      case 'pack-odds': openPackOdds(D.packById[id]); break;
      case 'go-pack': e.preventDefault(); closeModal(); ui.pack = id; if (ui.route !== 'packs') navigate('packs'); else render(); break;
      case 'zoom': openZoom(id, Number(el.getAttribute('data-uid')) || null); break;
      case 'rip': startRip(Number(el.getAttribute('data-count'))); break;
      case 'rip-resume': resumeRip(); break;
      case 'rip-retry': askWallet(); break;
      case 'rip-check': ui.opening.status = 'waiting'; renderOverlay(); pollRip(0); break;
      case 'rip-tx':
        var txv = ($('#rip-tx') || {}).value || '';
        if (!txv.trim()) break;
        ui.opening.tx = txv.trim(); ui.opening.status = 'waiting'; ui.opening.error = null; renderOverlay(); pollRip(0);
        break;
      case 'rip-later': ui.opening = null; renderOverlay(); render(); break;
      case 'rip-refund':
        store.ripCancel().then(function () { ui.opening = null; renderOverlay(); render(); toast('Cancelled. Nothing was paid.'); },
          function (e) { toast(e.message, true); });
        break;
      case 'vsort': ui.vaultSort = id; render(); break;
      case 'sell': sell([uid]); break;
      case 'sell-rip': sellFromRip([uid]); break;
      case 'sell-all-rip': sellFromRip(ui.opening.items.filter(function (it) { return !ui.opening.sold[it.uid]; }).map(function (it) { return it.uid; })); break;
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
  function onImgError(e) {
    var el = e.target;
    if (!el.classList) return;
    if (el.classList.contains('real')) el.remove();
    else if (el.classList.contains('wallet-ico')) {
      // Wallet logo blocked or missing: fall back to its initial.
      var span = doc.createElement('span');
      span.className = 'wallet-ico';
      var name = el.parentNode && el.parentNode.querySelector('.wallet-name');
      span.textContent = name ? name.textContent.charAt(0) : '?';
      el.replaceWith(span);
    }
  }

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
    if (!app) return; // loaded only for its renderers (e.g. assets/brand/x-header.html)
    ['overlay', 'modal', 'toasts'].forEach(function (id) {
      if (!$('#' + id)) { var d = doc.createElement('div'); d.id = id; if (id === 'toasts') d.className = 'toasts'; doc.body.appendChild(d); }
    });
    app.innerHTML = '<div class="wrap muted" style="padding-block:80px;text-align:center">Loading StonkPacks…</div>';
    doc.addEventListener('click', onClick);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('load', onImgLoad, true);
    doc.addEventListener('error', onImgError, true);
    root.addEventListener('hashchange', setRoute);
    root.addEventListener('popstate', setRoute);
    root.addEventListener('scroll', docSpy, { passive: true });
    root.addEventListener('resize', syncTopbar);
    doc.addEventListener('click', onLink);
    store.subscribe(function () { if (!ui.opening) render(); });
    root.addEventListener('beforeunload', function () { /* open rips stay saved and can be resumed */ });
    store.init().then(function () {
      // Back from a redirect-based NEAR wallet (MyNearWallet): finish the sign-in.
      var back = W.takeNearRedirect();
      if (back && !store.state.user) {
        store.finishWallet('near', back.nonce, back.signed).then(function () { toast('Welcome ' + store.state.user.name + '!'); refreshBalance(); }, function (e) { toast(e.message, true); });
      }
      setRoute();
      refreshBalance();
      // Keep the NEAR price fresh; a closed site opens by itself once a price is available.
      root.setInterval(function () { if (!ui.opening && !doc.hidden) { store.refreshGame(); refreshBalance(); } }, 30000);
      // Back from a redirect wallet after paying: continue the open rip with that transaction.
      try {
        var q = new URLSearchParams(root.location.search);
        var hashes = q.get('transactionHashes');
        if (hashes && store.state.pendingRip) {
          ui.returnedTx = hashes.split(',').pop();
          root.history.replaceState(null, '', root.location.pathname + (cleanUrls() ? '' : root.location.hash));
          resumeRip();
        }
      } catch (e) { /* ignore */ }
    });
  }

  root.PN.ui = { packArtHTML: packArtHTML, cardHTML: cardHTML };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

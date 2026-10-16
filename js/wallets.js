/* Pokenear wallet bridge: talks to Solana browser wallets and NEAR Wallet Selector,
   and turns a sign-in nonce into a signed message for store.connectWallet(). */
(function (root) {
  'use strict';

  var A = root.PN.auth;
  var CFG = root.PN_CONFIG || {};
  var PENDING_KEY = 'pokenear:near-pending';

  function pageUrl() { return root.location.origin + root.location.pathname; }
  function isMobile() { return /Android|iPhone|iPad|iPod/i.test(root.navigator.userAgent || ''); }

  function bytesToBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return root.btoa(bin);
  }

  /* ---------- Solana ---------- */
  var SOLANA = [
    {
      id: 'phantom', name: 'Phantom', color: '#ab9ff2',
      provider: function () { var p = root.phantom && root.phantom.solana; return p && p.isPhantom ? p : null; },
      install: 'https://phantom.app/download',
      open: function (url) { return 'https://phantom.app/ul/browse/' + encodeURIComponent(url) + '?ref=' + encodeURIComponent(root.location.origin); }
    },
    {
      id: 'solflare', name: 'Solflare', color: '#fc7227',
      provider: function () { var p = root.solflare; return p && p.isSolflare ? p : null; },
      install: 'https://solflare.com/download',
      open: function (url) { return 'https://solflare.com/ul/v1/browse/' + encodeURIComponent(url) + '?ref=' + encodeURIComponent(root.location.origin); }
    },
    {
      id: 'backpack', name: 'Backpack', color: '#e33e3f',
      provider: function () { return root.backpack && root.backpack.isBackpack !== false && root.backpack.connect ? root.backpack : null; },
      install: 'https://backpack.app/downloads',
      open: null
    }
  ];

  function solanaWallets() {
    return SOLANA.map(function (w) {
      return { id: w.id, name: w.name, color: w.color, installed: !!w.provider(), install: w.install, openUrl: w.open && isMobile() ? w.open(pageUrl()) : null };
    });
  }

  // Connect, then sign the sign-in message. Returns a signer for store.connectWallet.
  function solanaSigner(id) {
    var w = SOLANA.filter(function (x) { return x.id === id; })[0];
    var provider = w && w.provider();
    if (!provider) return null;
    return function (nonce) {
      return Promise.resolve(provider.connect()).then(function () {
        var pk = provider.publicKey;
        if (!pk) throw new Error(w.name + ' did not share an address.');
        var address = pk.toBase58 ? pk.toBase58() : String(pk);
        var message = new TextEncoder().encode(A.loginMessage('solana', address, nonce));
        return Promise.resolve(provider.signMessage(message, 'utf8')).then(function (out) {
          var sig = out && out.signature ? out.signature : out;
          return { address: address, signature: bytesToBase64(new Uint8Array(sig)), wallet: w.name };
        });
      });
    };
  }

  /* ---------- NEAR ---------- */
  var nearLoad = null;
  function loadNear() {
    if (nearLoad) return nearLoad;
    nearLoad = new Promise(function (resolve, reject) {
      if (root.PNNear) return resolve(root.PNNear);
      var s = root.document.createElement('script');
      s.src = 'vendor/near-wallet.js';
      s.onload = function () { root.PNNear ? resolve(root.PNNear) : reject(new Error('NEAR wallets failed to load.')); };
      s.onerror = function () { reject(new Error('NEAR wallets failed to load. Check your connection and try again.')); };
      root.document.head.appendChild(s);
    }).then(function (near) {
      return near.init(CFG.nearNetwork || 'mainnet').then(function (list) { return { near: near, list: list }; });
    });
    nearLoad.catch(function () { nearLoad = null; });
    return nearLoad;
  }

  function nearWallets() {
    return loadNear().then(function (x) { return x.list; });
  }

  function nearSigner(id, name) {
    return function (nonce) {
      var callbackUrl = pageUrl();
      try { root.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ nonce: nonce, wallet: name, callbackUrl: callbackUrl })); } catch (e) { /* redirect wallets will not complete */ }
      return loadNear().then(function (x) {
        return x.near.signIn(id, { message: A.loginMessage('near', null, nonce), recipient: A.NEAR_RECIPIENT, nonceHex: nonce, callbackUrl: callbackUrl });
      }).then(function (signed) {
        if (!signed) return new Promise(function () {}); // wallet redirected away; finished on return
        try { root.sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
        return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, wallet: name, callbackUrl: callbackUrl };
      });
    };
  }

  // Redirect wallets (MyNearWallet) come back with the signed message in the URL hash.
  function takeNearRedirect() {
    var h = root.location.hash || '';
    if (h.indexOf('signature=') < 0) return null;
    var pending = null;
    try { pending = JSON.parse(root.sessionStorage.getItem(PENDING_KEY) || 'null'); root.sessionStorage.removeItem(PENDING_KEY); } catch (e) { pending = null; }
    var q = new URLSearchParams(h.slice(1));
    root.history.replaceState(null, '', root.location.pathname + root.location.search + '#packs');
    if (!pending || !q.get('accountId')) return null;
    return { nonce: pending.nonce, signed: { accountId: q.get('accountId'), publicKey: q.get('publicKey'), signature: q.get('signature'), wallet: pending.wallet, callbackUrl: pending.callbackUrl } };
  }

  /* ---------- demo ---------- */
  // Preview only: a random Solana-format address so the app can be tried without a wallet.
  function demoSigner() {
    return function () {
      var b = new Uint8Array(32);
      root.crypto.getRandomValues(b);
      return { address: A.base58Encode(b), signature: '', wallet: 'Demo wallet' };
    };
  }

  root.PN.wallets = {
    solanaWallets: solanaWallets,
    solanaSigner: solanaSigner,
    nearWallets: nearWallets,
    nearSigner: nearSigner,
    takeNearRedirect: takeNearRedirect,
    demoSigner: demoSigner
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

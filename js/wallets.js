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
  // Official wallet logos (from the @solana/wallet-adapter-* packages).
  var ICONS = {
      "phantom": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==",
      "solflare": "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PC9kZWZzPjxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTIiIHJ5PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==",
      "backpack": "data:image/png;base64,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"
  };

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
      return { id: w.id, name: w.name, color: w.color, icon: ICONS[w.id], installed: !!w.provider(), install: w.install, openUrl: w.open && isMobile() ? w.open(pageUrl()) : null };
    });
  }

  // Signatures come back as bytes from most wallets, as base58 text from a few.
  function signatureToBase64(sig) {
    if (typeof sig === 'string') {
      var raw = A.base58Decode(sig);
      if (!raw) throw new Error('The wallet returned a signature in an unknown format.');
      return bytesToBase64(raw);
    }
    if (sig && sig.data && Array.isArray(sig.data)) sig = sig.data; // serialized Buffer
    return bytesToBase64(new Uint8Array(sig));
  }

  // Connect, then sign the sign-in message. Returns a signer for store.connectWallet.
  // The exact signed text goes to the server, which verifies the signature over those bytes.
  function solanaSigner(id) {
    var w = SOLANA.filter(function (x) { return x.id === id; })[0];
    var provider = w && w.provider();
    if (!provider) return null;
    return function (nonce) {
      return Promise.resolve(provider.connect()).then(function (resp) {
        var pk = (resp && resp.publicKey) || provider.publicKey;
        if (!pk) throw new Error(w.name + ' did not share an address.');
        var address = pk.toBase58 ? pk.toBase58() : String(pk);
        var text = A.loginMessage('solana', address, nonce);
        return Promise.resolve(provider.signMessage(new TextEncoder().encode(text), 'utf8')).then(function (out) {
          var sig = out && out.signature !== undefined ? out.signature : out;
          var signer = out && out.publicKey ? (out.publicKey.toBase58 ? out.publicKey.toBase58() : String(out.publicKey)) : address;
          return { address: signer, signature: signatureToBase64(sig), message: text, wallet: w.name };
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
      try { root.localStorage.setItem(NEAR_WALLET_KEY, id); } catch (e) { /* ignore */ }
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

  /* ---------- on-chain randomness for a rip ---------- */
  var NEAR_WALLET_KEY = 'pokenear:near-wallet';

  /* Pay for a rip in $POKENEAR from the player's NEAR wallet. pay comes from the server:
     { token, receiver, amount, msg }. Resolves { tx, ref } once the transaction is sent; the
     server then reads the draw from chain. */
  function payRip(user, pay) {
    if (!pay || !pay.token) return Promise.reject(new Error('Packs open when ' + root.PN.data.TOKEN + ' is live.'));
    var walletId = null;
    try { walletId = root.localStorage.getItem(NEAR_WALLET_KEY); } catch (e) { /* ignore */ }
    if (!walletId) return Promise.reject(new Error('Reconnect your NEAR wallet to pay.'));
    return loadNear().then(function (x) {
      return x.near.pay(walletId, { tokenId: pay.token, receiverId: pay.receiver, amount: pay.amount, msg: pay.msg, accountId: user.address });
    }).then(function (out) { return out ? { tx: out.tx, ref: pay.receiver } : new Promise(function () {}); });
  }

  // Block explorer links for a proof.
  function explorer(proof, network) {
    if (!proof) return null;
    if (proof.source === 'pokenear-near' || proof.source === 'near-rng') {
      var host = network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
      return { label: 'NearBlocks', account: proof.ref ? host + '/address/' + proof.ref : null, tx: proof.tx ? host + '/txns/' + proof.tx : null };
    }
    return null;
  }

  /* ---------- demo ---------- */
  // Preview only: a random NEAR implicit account so the app can be tried without a wallet.
  function demoSigner() {
    return function () {
      var b = new Uint8Array(32);
      root.crypto.getRandomValues(b);
      var hex = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return { accountId: hex, signature: '', wallet: 'Demo wallet' };
    };
  }

  root.PN.wallets = {
    solanaWallets: solanaWallets,
    solanaSigner: solanaSigner,
    nearWallets: nearWallets,
    nearSigner: nearSigner,
    takeNearRedirect: takeNearRedirect,
    payRip: payRip,
    explorer: explorer,
    demoSigner: demoSigner
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

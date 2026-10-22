/* StonkPacks store: picks a backend and exposes one async API to the UI.
   - live:  the Node server (server/server.js) verifies wallet signatures and owns game state.
   - local: no server (static hosting, previews); the engine runs in the browser and state
            lives in localStorage. Wallet signatures are still requested but not verified. */
(function (root) {
  'use strict';

  var engine = root.PN.engine;
  var STORAGE_KEY = 'nearpacks:v6';

  function safeGet(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* storage blocked: keep in memory */ }
  }
  function safeRemove(key) {
    try { root.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  var listeners = [];
  var store = {
    mode: 'local',
    state: engine.emptyState(),
    chains: ['near'],
    devAccounts: [],
    // Payment config from the interaction wallet's contract (live) or a demo stand-in (local).
    game: null,

    subscribe: function (fn) { listeners.push(fn); },
    emit: function () { listeners.forEach(function (fn) { fn(store.state); }); },

    init: function () {
      return fetchJSON('api/config')
        .then(function (cfg) {
          if (cfg && cfg.mode === 'live') {
            store.mode = 'live';
            store.game = cfg.game || null;
            store.chains = cfg.chains || ['near'];
            store.chain = cfg.chain || root.PN.data.CHAIN;
            store.devAccounts = cfg.devAccounts || [];
            store.adminAccounts = cfg.adminAccounts || null;
            store.serverVersion = cfg.version || null;
            return fetchJSON('api/me').then(function (me) {
              store.state = (me && me.state && engine.migrate(me.state)) || engine.emptyState();
            });
          }
          throw new Error('local');
        })
        .catch(function () {
          store.mode = 'local';
          store.game = { demo: true, ready: true, buyback: true, account: root.PN.data.GAME_ACCOUNT };
          var raw = safeGet(STORAGE_KEY);
          var loaded = null;
          try { loaded = raw ? JSON.parse(raw) : null; } catch (e) { loaded = null; }
          store.state = loaded ? engine.migrate(loaded) : engine.emptyState();
        })
        .then(function () { store.emit(); return store.state; });
    },

    // Re-reads the live game config (price, mode) so a closed site opens without a reload.
    refreshGame: function () {
      if (store.mode !== 'live') return Promise.resolve(null);
      return fetchJSON('api/config').then(function (cfg) {
        if (cfg && cfg.game) { store.game = cfg.game; store.devAccounts = cfg.devAccounts || store.devAccounts; store.emit(); }
        return store.game;
      }).catch(function () { return null; });
    },

    // Local (demo) mode only: run the engine in the browser.
    dispatch: function (action) {
      return new Promise(function (resolve) {
        var out = engine.apply(store.state, action, { now: Date.now(), mode: 'local' });
        store.state = out.state;
        safeSet(STORAGE_KEY, JSON.stringify(store.state));
        store.emit();
        resolve(out.result);
      });
    },

    /* Sign in with a wallet.
       signer(nonce) -> Promise<{ address | accountId, signature, publicKey?, wallet, callbackUrl? }>
       The server issues the nonce and verifies the signature; locally a random nonce is used. */
    connectWallet: function (chain, signer) {
      var getNonce = store.mode === 'live'
        ? postJSON('api/auth/nonce', {}).then(function (b) { return b.nonce; })
        : Promise.resolve(randomHex(32));
      return getNonce.then(function (nonce) {
        return Promise.resolve(signer(nonce)).then(function (signed) {
          return store.finishWallet(chain, nonce, signed);
        });
      });
    },

    // Second half of sign-in; also used when a NEAR wallet returns from a redirect.
    finishWallet: function (chain, nonce, signed) {
      if (store.mode === 'live') {
        return postJSON('api/auth/wallet', {
          chain: chain, nonce: nonce, signature: signed.signature, address: signed.address,
          accountId: signed.accountId, publicKey: signed.publicKey, callbackUrl: signed.callbackUrl, message: signed.message,
          wallet: signed.wallet
        }).then(function (body) {
          store.state = body.state;
          store.emit();
          return {};
        });
      }
      return store.dispatch({ type: 'connect', chain: chain, address: signed.address || signed.accountId, wallet: signed.wallet });
    },

    /* ---------- rips ----------
       ripStart: reserve a seed; live mode also returns what to pay (store.pay).
       ripFinish: deliver the cards once the payment + randomness is on chain
       (live: read from chain by the server; demo: browser randomness, nothing paid). */
    ripStart: function (pack, count) {
      if (store.mode === 'live') {
        return postJSON('api/rip/start', { pack: pack, count: count }).then(function (b) {
          store.state = b.state;
          store.pay = b.pay;
          store.devResult = b.result || null; // dev wallet: the rip is already drawn and recorded
          store.emit();
          return b.rip;
        });
      }
      var u = store.state.user;
      store.pay = null;
      return store.dispatch({ type: 'ripStart', pack: pack, count: count, seed: randomHex(32), chain: u && u.chain, source: 'demo' })
        .then(function (r) { return r.rip; });
    },

    // -> { pending: true } while the chain has no randomness yet, else the rip result.
    ripFinish: function (extra) {
      if (store.mode === 'live') {
        return fetch('api/rip/finish', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(extra || {})
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (b) {
            if (res.status === 202) { if (b.pay) store.pay = b.pay; return { pending: true, status: b.status }; }
            if (!res.ok || b.error) throw new Error(b.error || 'Server error (' + res.status + '). Try again.');
            store.state = b.state;
            store.emit();
            return b.result;
          });
        });
      }
      return store.dispatch({ type: 'ripFinish', proof: { randomness: randomHex(64), source: 'demo' } });
    },

    ripCancel: function () {
      if (store.mode === 'live') {
        return postJSON('api/rip/cancel', {}).then(function (b) { store.state = b.state; store.emit(); return b.result; });
      }
      return store.dispatch({ type: 'ripCancel' });
    },

    // Sell cards back. Live: the interaction wallet pays NEAR on chain before the cards leave.
    buyback: function (uids) {
      if (store.mode === 'live') {
        return postJSON('api/buyback', { uids: uids }).then(function (b) { store.state = b.state; store.emit(); return b.result; });
      }
      return store.dispatch({ type: 'buyback', uids: uids });
    },

    // Admin page: only the admin wallet (nearpacks.near), live mode.
    isAdmin: function () {
      var u = store.state.user;
      var admins = store.adminAccounts || root.PN.data.ADMIN_ACCOUNTS;
      return store.mode === 'live' && !!u && u.chain === (store.chain || root.PN.data.CHAIN) && admins.indexOf(u.address) >= 0;
    },
    adminStatus: function () { return fetchJSONOrError('api/admin/status'); },
    adminPurge: function () { return postJSON('api/admin/purge', {}); },
    adminSetPrice: function (nearUsd) { return postJSON('api/admin/price', { nearUsd: nearUsd }); },

    // Dev wallet (nearpacks.near): rips without paying, recorded as dev rips.
    isDev: function () {
      var u = store.state.user;
      return store.mode === 'live' && !!u && store.devAccounts.indexOf(u.address) >= 0;
    },

    // On-chain NEAR balance of the signed-in wallet: { amount, decimals } or null.
    // NEAR in the player's wallet: from the server, or straight from a public NEAR RPC if the
    // server cannot answer.
    balance: function () {
      var u = store.state.user;
      if (!u) return Promise.resolve(null);
      var fromServer = store.mode === 'live' ? fetchJSON('api/balance').catch(function () { return null; }) : Promise.resolve(null);
      return fromServer.then(function (b) { return b && b.amount != null ? b : u.chain === 'solana' ? solBalance(u.address) : u.chain === 'near' ? rpcBalance(u.address) : null; });
    },

    logout: function () {
      if (store.mode === 'live') {
        return fetch('api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
          store.state = engine.emptyState();
          store.emit();
        });
      }
      safeRemove(STORAGE_KEY);
      store.state = engine.emptyState();
      store.emit();
      return Promise.resolve();
    },

    leaderboard: function () {
      if (store.mode === 'live') {
        return fetchJSON('api/leaderboard').then(function (b) { return (b && b.rows) || []; });
      }
      return Promise.resolve(null); // UI builds sample rows in demo mode
    }
  };

  function randomHex(n) {
    var b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || b.error) throw new Error(b.error || 'Server error (' + res.status + '). Try again.');
        return b;
      });
    });
  }

  // GET that surfaces the server's error message.
  function fetchJSONOrError(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || b.error) throw new Error(b.error || 'Server error (' + res.status + ').');
        return b;
      });
    });
  }

  function solBalance(address) {
    var urls = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
    function ask(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetch(urls[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { return j && j.result && j.result.value != null ? { amount: String(j.result.value), decimals: 9, symbol: 'SOL' } : ask(i + 1); })
        .catch(function () { return ask(i + 1); });
    }
    return ask(0);
  }
  function rpcBalance(account) {
    var cfg = root.PN_CONFIG || {};
    var urls = cfg.nearNetwork === 'testnet' ? ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'] : ['https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'];
    function ask(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetch(urls[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'np', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { return j && j.result && j.result.amount ? { amount: j.result.amount, decimals: 24, symbol: 'NEAR' } : ask(i + 1); })
        .catch(function () { return ask(i + 1); });
    }
    return ask(0);
  }

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) throw new Error('not json');
      return res.json();
    });
  }

  root.PN.store = store;
})(typeof globalThis !== 'undefined' ? globalThis : this);

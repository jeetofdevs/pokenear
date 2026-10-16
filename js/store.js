/* Pokenear store: picks a backend and exposes one async API to the UI.
   - live:  the Node server (server/server.js) is running with X OAuth configured.
   - local: no server; the engine runs in the browser and state lives in localStorage. */
(function (root) {
  'use strict';

  var engine = root.PN.engine;
  var STORAGE_KEY = 'pokenear:v2';
  var REF_KEY = 'pokenear:ref';

  function safeGet(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* storage blocked: keep in memory */ }
  }
  function safeRemove(key) {
    try { root.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function cryptoRng() {
    var buf = new Uint32Array(1);
    root.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }

  // Invite codes arrive as ?ref=CODE or #ref-CODE (artifact viewers only keep the hash).
  function captureRef() {
    var code = null;
    try {
      var q = new URLSearchParams(root.location.search).get('ref');
      if (q) code = q;
    } catch (e) { /* ignore */ }
    var m = /^#ref-([A-Za-z0-9]{4,12})$/.exec(root.location.hash || '');
    if (m) code = m[1];
    if (code && /^[A-Za-z0-9]{4,12}$/.test(code)) {
      safeSet(REF_KEY, code.toUpperCase());
      return code.toUpperCase();
    }
    return safeGet(REF_KEY);
  }

  var listeners = [];
  var store = {
    mode: 'local',
    state: engine.emptyState(),
    ref: null,

    subscribe: function (fn) { listeners.push(fn); },
    emit: function () { listeners.forEach(function (fn) { fn(store.state); }); },

    init: function () {
      store.ref = captureRef();
      return fetchJSON('api/config')
        .then(function (cfg) {
          if (cfg && cfg.mode === 'live') {
            store.mode = 'live';
            return fetchJSON('api/me').then(function (me) {
              store.state = (me && me.state) || engine.emptyState();
            });
          }
          throw new Error('local');
        })
        .catch(function () {
          store.mode = 'local';
          var raw = safeGet(STORAGE_KEY);
          var loaded = null;
          try { loaded = raw ? JSON.parse(raw) : null; } catch (e) { loaded = null; }
          store.state = loaded && loaded.v === 2 ? loaded : engine.emptyState();
        })
        .then(function () { store.emit(); return store.state; });
    },

    dispatch: function (action) {
      if (store.mode === 'live') {
        return fetch('api/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action)
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok || body.error) throw new Error(body.error || 'Server error (' + res.status + '). Try again.');
            store.state = body.state;
            store.emit();
            return body.result;
          });
        });
      }
      return new Promise(function (resolve) {
        var out = engine.apply(store.state, action, { rng: cryptoRng, now: Date.now(), mode: 'local' });
        store.state = out.state;
        safeSet(STORAGE_KEY, JSON.stringify(store.state));
        store.emit();
        resolve(out.result);
      });
    },

    // Live mode hands off to X OAuth; local mode takes a typed handle.
    connectX: function (handle) {
      if (store.mode === 'live') {
        var url = 'auth/x/login' + (store.ref ? '?ref=' + encodeURIComponent(store.ref) : '');
        root.location.href = url;
        return new Promise(function () {});
      }
      return store.dispatch({ type: 'connect', handle: handle, name: handle, ref: store.ref }).then(function (r) {
        safeRemove(REF_KEY);
        return r;
      });
    },

    logout: function () {
      if (store.mode === 'live') {
        return fetch('auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
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

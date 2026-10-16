/* Wallet sign-in helpers shared by the browser and the Node server.
   Supported chains: Solana (Phantom, Solflare, Backpack) and NEAR (via NEAR Wallet Selector).
   Sign-in = the wallet signs a plain-text message with a server nonce. No transaction, no fee. */
(function (root) {
  'use strict';

  var APP = 'Pokenear';
  var NEAR_RECIPIENT = 'pokenear';
  var CHAINS = {
    solana: { id: 'solana', name: 'Solana' },
    near: { id: 'near', name: 'NEAR' }
  };

  var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var MAP = {};
  for (var i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]] = i;

  function base58Encode(bytes) {
    var digits = []; // no implicit 0 digit: an all-zero input is only its leading '1's
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
    for (var q = digits.length - 1; q >= 0; q--) out += ALPHABET[digits[q]];
    return out;
  }

  function base58Decode(str) {
    if (typeof str !== 'string' || !str) return null;
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var v = MAP[str[i]];
      if (v === undefined) return null;
      var carry = v;
      for (var j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (var k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  // Solana address = base58 of a 32-byte ed25519 public key.
  function isSolanaAddress(a) {
    if (typeof a !== 'string' || a.length < 32 || a.length > 44) return false;
    var b = base58Decode(a);
    return !!b && b.length === 32;
  }

  // NEAR account: named (alice.near, x.tg) or implicit (64 hex chars).
  function isNearAccount(a) {
    if (typeof a !== 'string' || a.length < 2 || a.length > 64) return false;
    return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a);
  }

  function isValidAddress(chain, address) {
    if (chain === 'solana') return isSolanaAddress(address);
    if (chain === 'near') return isNearAccount(address);
    return false;
  }

  function shortAddress(a) {
    if (!a) return '';
    if (/\.(near|tg|testnet)$/.test(a) && a.length <= 22) return a;
    return a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a;
  }

  // The exact text the wallet signs. Solana knows the address up front; NEAR wallets
  // report the account only after signing, so the NEAR message names no account.
  function loginMessage(chain, address, nonce) {
    var lines = [APP + ' wants you to sign in with your ' + CHAINS[chain].name + ' wallet.'];
    if (chain === 'solana') lines.push('', address);
    lines.push('', 'This signature only proves you own this wallet. It does not send a transaction or cost any fee.', '', 'Nonce: ' + nonce);
    return lines.join('\n');
  }

  var auth = {
    APP: APP,
    NEAR_RECIPIENT: NEAR_RECIPIENT,
    CHAINS: CHAINS,
    base58Encode: base58Encode,
    base58Decode: base58Decode,
    isSolanaAddress: isSolanaAddress,
    isNearAccount: isNearAccount,
    isValidAddress: isValidAddress,
    shortAddress: shortAddress,
    loginMessage: loginMessage
  };

  root.PN = root.PN || {};
  root.PN.auth = auth;
  if (typeof module !== 'undefined' && module.exports) module.exports = auth;
})(typeof globalThis !== 'undefined' ? globalThis : this);

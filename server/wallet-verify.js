'use strict';
/* Server-side checks for wallet sign-in. Uses only node:crypto.
   - Solana: ed25519 signature over the UTF-8 sign-in message, key = the address itself.
   - NEAR: NEP-413 signed message (sha256 of the Borsh payload, ed25519), then confirm the
     signing key is a full-access key of the account (implicit account or NEAR RPC). */
const crypto = require('node:crypto');
const auth = require('../js/auth.js');

const NEP413_TAG = 2 ** 31 + 413;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Key(raw32) {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw32)]), format: 'der', type: 'spki' });
}

function verifyEd25519(raw32, data, signature) {
  try {
    return crypto.verify(null, Buffer.from(data), ed25519Key(raw32), Buffer.from(signature));
  } catch {
    return false;
  }
}

function decodeSignature(sig) {
  if (typeof sig !== 'string') return null;
  const b = /^[0-9a-f]{128}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.from(sig, 'base64');
  return b.length === 64 ? b : null;
}

// Ledger accounts (e.g. through Phantom) sign Solana "off-chain messages": the text wrapped in a
// header. Format v0: "\xffsolana offchain" | version 0 | format (0 ASCII, 1 UTF-8) | u16 LE length | text.
function offchainMessage(text, format) {
  const body = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16LE(body.length);
  return Buffer.concat([Buffer.from('\xffsolana offchain', 'latin1'), Buffer.from([0, format]), len, body]);
}

// Returns the variant that verified ('raw' or 'offchain'), or null.
function verifySolana({ address, signature, message }) {
  const key = auth.base58Decode(address);
  const sig = decodeSignature(signature);
  if (!key || key.length !== 32 || !sig) return null;
  if (verifyEd25519(key, Buffer.from(message, 'utf8'), sig)) return 'raw';
  for (const format of [0, 1]) if (verifyEd25519(key, offchainMessage(message, format), sig)) return 'offchain';
  return null;
}

function borshString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

// NEP-413: sha256( u32 tag || borsh({ message, nonce[32], recipient, callbackUrl?: string }) )
function nep413Hash({ message, nonce, recipient, callbackUrl }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const parts = [tag, borshString(message), Buffer.from(nonce), borshString(recipient)];
  parts.push(callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]) : Buffer.from([0]));
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
}

function parseNearKey(publicKey) {
  const m = /^(?:ed25519:)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(publicKey || '');
  const raw = m && auth.base58Decode(m[1]);
  return raw && raw.length === 32 ? raw : null;
}

// Wallets differ on callbackUrl: HOT and Meteor sign the payload without it, redirect wallets
// (MyNearWallet) may include it. Accept either; the nonce still binds the signature to this login.
function verifyNearSignature({ publicKey, signature, message, nonce, recipient, callbackUrl }) {
  const raw = parseNearKey(publicKey);
  const sig = decodeSignature(signature);
  if (!raw || !sig || !nonce || nonce.length !== 32) return false;
  const variants = callbackUrl ? [undefined, callbackUrl] : [undefined];
  return variants.some((cb) => verifyEd25519(raw, nep413Hash({ message, nonce, recipient, callbackUrl: cb }), sig));
}

function nearKeyString(publicKey) {
  const raw = parseNearKey(publicKey);
  return raw ? 'ed25519:' + auth.base58Encode(raw) : null;
}

// The key must be a full-access key of the account the wallet reported.
async function nearKeyBelongsTo(accountId, publicKey, rpcUrl) {
  const raw = parseNearKey(publicKey);
  if (!raw) return false;
  if (/^[0-9a-f]{64}$/.test(accountId)) return Buffer.from(raw).toString('hex') === accountId;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'pokenear', method: 'query',
      params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }
    })
  });
  if (!res.ok) throw new Error('NEAR RPC ' + res.status);
  const body = await res.json();
  if (body.error || !body.result) return false;
  return body.result.permission === 'FullAccess';
}

module.exports = { offchainMessage, verifySolana, verifyNearSignature, nearKeyString, nearKeyBelongsTo, nep413Hash, NEP413_TAG };

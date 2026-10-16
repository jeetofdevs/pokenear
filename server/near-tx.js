'use strict';
/* Minimal NEAR transaction signer (node:crypto only) for one job: the server calling
   payout() on the Pokenear contract with a function-call access key of the interaction wallet.

   Borsh layout (nearcore):
     Transaction { signer_id: string, public_key: PublicKey, nonce: u64, receiver_id: string,
                   block_hash: [u8; 32], actions: Vec<Action> }
     PublicKey   { key_type: u8 (0 = ed25519), data: [u8; 32] }
     Action::FunctionCall (enum index 2) { method_name: string, args: Vec<u8>, gas: u64, deposit: u128 }
     SignedTransaction { transaction, signature: { key_type: u8, data: [u8; 64] } }
   The signature is ed25519 over sha256(borsh(Transaction)). */
const crypto = require('node:crypto');
const auth = require('../js/auth.js');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function u128(n) {
  let v = BigInt(n);
  if (v < 0n || v >= 2n ** 128n) throw new Error('u128 out of range');
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function str(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); }
function bytes(b) { return Buffer.concat([u32(b.length), Buffer.from(b)]); }

// "ed25519:<base58 of 64 bytes (seed + public key)>" -> { seed, publicKey, publicKeyString }
function parseSecretKey(secret) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(secret || '').trim());
  const raw = m && auth.base58Decode(m[1]);
  if (!raw || (raw.length !== 64 && raw.length !== 32)) throw new Error('Expected an ed25519:... NEAR secret key');
  const seed = Buffer.from(raw.slice(0, 32));
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (raw.length === 64 && !Buffer.from(raw.slice(32)).equals(publicKey)) throw new Error('Secret key and public key do not match');
  return { key, publicKey, publicKeyString: 'ed25519:' + auth.base58Encode(publicKey) };
}

function functionCall(method, args, gas, deposit) {
  return Buffer.concat([Buffer.from([2]), str(method), bytes(Buffer.from(JSON.stringify(args))), u64(gas), u128(deposit)]);
}

function serializeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const hash = Buffer.from(auth.base58Decode(blockHash));
  if (hash.length !== 32) throw new Error('Bad block hash');
  return Buffer.concat([str(signerId), Buffer.from([0]), Buffer.from(publicKey), u64(nonce), str(receiverId), hash, u32(actions.length), ...actions]);
}

function signTransaction(tx, key) {
  const body = serializeTransaction(tx);
  const hash = crypto.createHash('sha256').update(body).digest();
  const signature = crypto.sign(null, hash, key);
  return { signed: Buffer.concat([body, Buffer.from([0]), signature]), hash: auth.base58Encode(hash) };
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(method === 'broadcast_tx_commit' ? 60000 : 8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'pokenear', method, params })
  });
  if (!res.ok) throw new Error(method + ' HTTP ' + res.status);
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(method + ': ' + JSON.stringify(body.error.data || body.error.message || body.error).slice(0, 300)), { rpcError: body.error });
  return body.result;
}

/* Sign and send one function call as `signerId`, wait for the final outcome.
   Returns { hash, ok, value } where value is the decoded return value of the transaction
   (for payout(): the on_payout callback's true/false). */
async function callFunction(rpcUrl, { signerId, secretKey, receiverId, method, args, gas = 100e12, deposit = 0 }) {
  const k = parseSecretKey(secretKey);
  const ak = await rpc(rpcUrl, 'query', { request_type: 'view_access_key', finality: 'final', account_id: signerId, public_key: k.publicKeyString });
  const { signed, hash } = signTransaction({
    signerId, publicKey: k.publicKey, nonce: BigInt(ak.nonce) + 1n, receiverId, blockHash: ak.block_hash,
    actions: [functionCall(method, args, gas, deposit)]
  }, k.key);
  const out = await rpc(rpcUrl, 'broadcast_tx_commit', [signed.toString('base64')]);
  const status = out && out.status || {};
  if (!('SuccessValue' in status)) return { hash, ok: false, error: JSON.stringify(status.Failure || status).slice(0, 300) };
  let value = null;
  try { value = status.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString('utf8')) : null; } catch { value = null; }
  return { hash, ok: true, value };
}

module.exports = { parseSecretKey, functionCall, serializeTransaction, signTransaction, callFunction, u128 };

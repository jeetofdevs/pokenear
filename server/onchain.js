'use strict';
/* Reads rip randomness from chain.
   - Solana: ORAO VRF v2. The randomness account is the PDA ["orao-vrf-randomness-request", seed]
     of the ORAO program. Layout (Anchor): 8-byte discriminator | enum tag (0 pending, 1 fulfilled)
     | client pubkey (32) | seed (32) | fulfilled: randomness (64).
   - NEAR: the StonkPacks contract on the interaction wallet (contracts/near-rng), get_draw({ seed }):
     the randomness drawn when the player paid for the rip in NEAR. */
const crypto = require('node:crypto');
const auth = require('../js/auth.js');

const ORAO_PROGRAM = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';
const ORAO_SEED_PREFIX = Buffer.from('orao-vrf-randomness-request');
const DISC_V2 = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]);
const DISC_V1 = Buffer.from([188, 96, 216, 248, 93, 94, 49, 112]);

/* Solana program-derived addresses without @solana/web3.js (keeps the server dependency-free).
   PDA = sha256(seeds || bump || program id || "ProgramDerivedAddress") for the highest bump
   (255 down) whose hash is NOT a valid ed25519 point. */
const P = 2n ** 255n - 19n;
const D = ((-121665n * modPow(121666n, P - 2n)) % P + P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

function modPow(b, e) {
  let r = 1n;
  b %= P;
  if (b < 0n) b += P;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

// Same rule as RFC 8032 point decoding (what web3.js PublicKey.isOnCurve uses).
function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  const sign = b[31] >> 7;
  b[31] &= 0x7f;
  const y = BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * modPow(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 === u) { /* root found */ }
  else if (vx2 === (P - u) % P) x = (x * SQRT_M1) % P;
  else return false;
  if (x === 0n && sign === 1) return false;
  return true;
}

function findProgramAddress(seeds, programId) {
  const program = Buffer.from(auth.base58Decode(programId));
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256')
      .update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from('ProgramDerivedAddress')]))
      .digest();
    if (!isOnCurve(h)) return auth.base58Encode(h);
  }
  throw new Error('No program address found');
}

function oraoRandomnessAddress(seedHex) {
  return findProgramAddress([ORAO_SEED_PREFIX, Buffer.from(seedHex, 'hex')], ORAO_PROGRAM);
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nearpacks', method, params })
  });
  if (!res.ok) throw new Error(method + ' HTTP ' + res.status);
  const body = await res.json();
  if (body.error) throw new Error(method + ': ' + (body.error.message || JSON.stringify(body.error)));
  return body.result;
}

// -> { status: 'missing' | 'pending' | 'fulfilled', randomness?, account, client? }
async function solanaRandomness(rpcUrl, seedHex) {
  const account = oraoRandomnessAddress(seedHex);
  const result = await rpc(rpcUrl, 'getAccountInfo', [account, { encoding: 'base64', commitment: 'confirmed' }]);
  const info = result && result.value;
  if (!info) return { status: 'missing', account };
  if (info.owner !== ORAO_PROGRAM) throw new Error('Randomness account is not owned by ORAO VRF.');
  const data = Buffer.from(info.data[0], 'base64');
  const disc = data.subarray(0, 8);
  if (disc.equals(DISC_V2)) {
    const tag = data[8];
    const client = auth.base58Encode(data.subarray(9, 41));
    const seed = data.subarray(41, 73).toString('hex');
    if (seed !== seedHex) throw new Error('Randomness account seed does not match the rip.');
    if (tag === 0) return { status: 'pending', account, client };
    if (tag !== 1) throw new Error('Unknown ORAO request state.');
    return { status: 'fulfilled', account, client, randomness: data.subarray(73, 137).toString('hex') };
  }
  if (disc.equals(DISC_V1)) {
    const seed = data.subarray(8, 40).toString('hex');
    if (seed !== seedHex) throw new Error('Randomness account seed does not match the rip.');
    const r = data.subarray(40, 104);
    return r.every((b) => b === 0) ? { status: 'pending', account } : { status: 'fulfilled', account, randomness: r.toString('hex') };
  }
  throw new Error('Unknown ORAO account type.');
}

// -> { status: 'missing' } | { status: 'fulfilled', randomness, account, blockHeight }
// NEAR account state ({ amount, code_hash, ... }) or null if the account does not exist.
async function nearAccount(rpcUrl, accountId) {
  try {
    return await rpc(rpcUrl, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  } catch (err) {
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) return null;
    throw err;
  }
}

// An access key of an account, or null if it is not on the account.
async function nearAccessKey(rpcUrl, accountId, publicKey) {
  try {
    return await rpc(rpcUrl, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  } catch (err) {
    if (/UNKNOWN_ACCESS_KEY|does not exist|not found/i.test(err.message)) return null;
    throw err;
  }
}

// A plain NEAR transfer, looked up by hash and sender. status: 'pending' (not final yet or not
// found), 'failed', or 'ok' with { signer, receiver, deposit (one Transfer action), blockHash }.
async function nearTransferTx(rpcUrl, txHash, senderId) {
  let r;
  try {
    r = await rpc(rpcUrl, 'tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'FINAL' });
  } catch (err) {
    if (/UNKNOWN_TRANSACTION|TIMEOUT|doesn't exist|not found|timeout/i.test(err.message)) return { status: 'pending' };
    throw err;
  }
  const tx = r && r.transaction;
  if (!tx || !r.transaction_outcome) return { status: 'pending' };
  if (!r.status || !('SuccessValue' in r.status)) return { status: 'failed' };
  const actions = tx.actions || [];
  const transfer = actions.length === 1 && actions[0] && actions[0].Transfer;
  return {
    status: 'ok', signer: tx.signer_id, receiver: tx.receiver_id,
    deposit: transfer ? String(transfer.deposit) : null, blockHash: r.transaction_outcome.block_hash
  };
}

// Block header by hash: { height, timestampMs }.
async function nearBlock(rpcUrl, blockHash) {
  const r = await rpc(rpcUrl, 'block', { block_id: blockHash });
  return { height: r.header.height, timestampMs: Math.floor(Number(r.header.timestamp) / 1e6) };
}

// Call a NEAR view method and parse its JSON result.
async function nearView(rpcUrl, contractId, method, args) {
  const result = await rpc(rpcUrl, 'query', {
    request_type: 'call_function', finality: 'final', account_id: contractId,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args || {})).toString('base64')
  });
  const text = Buffer.from(result.result || []).toString('utf8');
  return text ? JSON.parse(text) : null;
}

// A paid rip on the StonkPacks contract (see contracts/near-rng): randomness + what was paid.
async function nearDraw(rpcUrl, contractId, seedHex) {
  const draw = await nearView(rpcUrl, contractId, 'get_draw', { seed: seedHex });
  if (!draw) return { status: 'missing' };
  if (!/^[0-9a-f]{64}$/.test(draw.randomness || '')) throw new Error('Bad randomness from the NEAR contract.');
  return {
    status: 'fulfilled', randomness: draw.randomness, account: draw.account, blockHeight: draw.block_height,
    pack: draw.pack, count: draw.count, amount: draw.amount
  };
}

module.exports = { ORAO_PROGRAM, ORAO_SEED_PREFIX, DISC_V2, DISC_V1, isOnCurve, findProgramAddress, oraoRandomnessAddress, solanaRandomness, nearView, nearDraw, nearAccount, nearAccessKey, nearTransferTx, nearBlock };

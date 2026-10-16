'use strict';
/* Reads rip randomness from chain.
   - Solana: ORAO VRF v2. The randomness account is the PDA ["orao-vrf-randomness-request", seed]
     of the ORAO program. Layout (Anchor): 8-byte discriminator | enum tag (0 pending, 1 fulfilled)
     | client pubkey (32) | seed (32) | fulfilled: randomness (64).
   - NEAR: the Pokenear RNG contract (contracts/near-rng), view method get_draw({ seed }). */
const { PublicKey } = require('@solana/web3.js');

const ORAO_PROGRAM = 'VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y';
const ORAO_SEED_PREFIX = Buffer.from('orao-vrf-randomness-request');
const DISC_V2 = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]);
const DISC_V1 = Buffer.from([188, 96, 216, 248, 93, 94, 49, 112]);

function oraoRandomnessAddress(seedHex) {
  return PublicKey.findProgramAddressSync([ORAO_SEED_PREFIX, Buffer.from(seedHex, 'hex')], new PublicKey(ORAO_PROGRAM))[0].toBase58();
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'pokenear', method, params })
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
    const client = new PublicKey(data.subarray(9, 41)).toBase58();
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
async function nearDraw(rpcUrl, contractId, seedHex) {
  const result = await rpc(rpcUrl, 'query', {
    request_type: 'call_function', finality: 'final', account_id: contractId,
    method_name: 'get_draw', args_base64: Buffer.from(JSON.stringify({ seed: seedHex })).toString('base64')
  });
  const text = Buffer.from(result.result || []).toString('utf8');
  const draw = text ? JSON.parse(text) : null;
  if (!draw) return { status: 'missing' };
  if (!/^[0-9a-f]{64}$/.test(draw.randomness || '')) throw new Error('Bad randomness from the NEAR contract.');
  return { status: 'fulfilled', randomness: draw.randomness, account: draw.account, blockHeight: draw.block_height };
}

module.exports = { ORAO_PROGRAM, ORAO_SEED_PREFIX, DISC_V2, DISC_V1, oraoRandomnessAddress, solanaRandomness, nearDraw };

'use strict';
// Checks the hand-written ORAO VRF account decoder against the official ORAO IDL + Anchor coder.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const idl = require('@orao-network/solana-vrf/dist/types/orao_vrf.json');
const onchain = require('../server/onchain.js');

// Reference libraries (dev only). @solana/web3.js cannot load on Node 18 (its uuid dependency
// is ESM-only), so the comparisons are skipped there; the server itself does not use them.
let BorshAccountsCoder, PublicKey, Keypair, sdk, skip = false;
try {
  ({ BorshAccountsCoder } = require('@coral-xyz/anchor'));
  ({ PublicKey, Keypair } = require('@solana/web3.js'));
  sdk = require('@orao-network/solana-vrf');
} catch (e) {
  skip = 'reference Solana libraries need Node 20+: ' + e.code;
}

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test('ORAO program id, PDA and discriminators match the SDK', { skip }, () => {
  assert.equal(onchain.ORAO_PROGRAM, sdk.PROGRAM_ADDRESS);
  const seed = crypto.randomBytes(32);
  assert.equal(onchain.oraoRandomnessAddress(seed.toString('hex')), sdk.randomnessAccountAddress(seed).toBase58());
  assert.deepEqual([...onchain.DISC_V2], idl.accounts.find((a) => a.name === 'RandomnessV2').discriminator);
  assert.deepEqual([...onchain.DISC_V1], idl.accounts.find((a) => a.name === 'Randomness').discriminator);
});

test('dependency-free PDA derivation and curve check match @solana/web3.js', { skip }, () => {
  for (let i = 0; i < 300; i++) {
    const seed = crypto.randomBytes(32);
    assert.equal(onchain.oraoRandomnessAddress(seed.toString('hex')), sdk.randomnessAccountAddress(seed).toBase58());
  }
  for (let i = 0; i < 2000; i++) {
    const b = crypto.randomBytes(32);
    assert.equal(onchain.isOnCurve(b), PublicKey.isOnCurve(b), b.toString('hex'));
  }
  for (let i = 0; i < 50; i++) {
    const k = Keypair.generate().publicKey.toBytes();
    assert.equal(onchain.isOnCurve(k), true);
  }
});

test('decoder reads pending and fulfilled ORAO accounts encoded by Anchor', { skip }, async () => {
  const coder = new BorshAccountsCoder(idl);
  const seed = crypto.randomBytes(32);
  const seedHex = seed.toString('hex');
  const client = Keypair.generate().publicKey;
  const randomness = crypto.randomBytes(64);
  const pending = await coder.encode('RandomnessV2', { request: { Pending: { 0: { client, seed: [...seed], responses: [] } } } });
  const fulfilled = await coder.encode('RandomnessV2', { request: { Fulfilled: { 0: { client, seed: [...seed], randomness: [...randomness] } } } });
  const address = onchain.oraoRandomnessAddress(seedHex);
  let current = null;
  let owner = onchain.ORAO_PROGRAM;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const { method, params } = JSON.parse(b);
      assert.equal(method, 'getAccountInfo');
      assert.equal(params[0], address);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { value: current && { owner, data: [current.toString('base64'), 'base64'] } } }));
    });
  });
  const url = `http://127.0.0.1:${await listen(srv)}`;
  try {
    assert.equal((await onchain.solanaRandomness(url, seedHex)).status, 'missing');
    current = pending;
    const p = await onchain.solanaRandomness(url, seedHex);
    assert.equal(p.status, 'pending');
    assert.equal(p.client, client.toBase58());
    current = fulfilled;
    const f = await onchain.solanaRandomness(url, seedHex);
    assert.equal(f.status, 'fulfilled');
    assert.equal(f.randomness, randomness.toString('hex'));
    assert.equal(f.account, address);
    // Same SDK decode for comparison.
    assert.deepEqual(Buffer.from(coder.decode('RandomnessV2', fulfilled).request.Fulfilled[0].randomness).toString('hex'), f.randomness);
    // Wrong owner or wrong seed is rejected.
    owner = new PublicKey(Keypair.generate().publicKey).toBase58();
    await assert.rejects(onchain.solanaRandomness(url, seedHex), /not owned by ORAO/);
    owner = onchain.ORAO_PROGRAM;
    current = await coder.encode('RandomnessV2', { request: { Fulfilled: { 0: { client, seed: [...crypto.randomBytes(32)], randomness: [...randomness] } } } });
    await assert.rejects(onchain.solanaRandomness(url, seedHex), /seed does not match/);
  } finally {
    srv.close();
  }
});

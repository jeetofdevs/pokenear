'use strict';
// Checks the dependency-free NEAR transaction signer against @near-js (the official JS SDK).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const auth = require('../js/auth.js');
const nearTx = require('../server/near-tx.js');

let T, C, skip = false;
try {
  T = require('@near-js/transactions');
  C = require('@near-js/crypto');
} catch (e) {
  skip = 'reference @near-js libraries unavailable: ' + e.code;
}

test('function-call transaction bytes and signature match @near-js', { skip }, () => {
  for (let i = 0; i < 20; i++) {
    const kp = C.KeyPairEd25519.fromRandom();
    const secret = kp.toString();
    const k = nearTx.parseSecretKey(secret);
    assert.equal(k.publicKeyString, kp.getPublicKey().toString());
    const blockHash = auth.base58Encode(crypto.randomBytes(32));
    const nonce = BigInt(crypto.randomInt(1, 2 ** 40)) * 1000n;
    const args = { receiver_id: 'bob.near', amount: String(BigInt(crypto.randomInt(1, 2 ** 40)) * 10n ** 18n), ref_id: 'sell:' + i };
    const deposit = i % 2 ? 1n : 0n;
    const gas = 100000000000000n;

    const ours = nearTx.signTransaction({
      signerId: 'nearpacks.near', publicKey: k.publicKey, nonce, receiverId: 'nearpacks.near', blockHash,
      actions: [nearTx.functionCall('payout', args, gas, deposit)]
    }, k.key);

    const tx = T.createTransaction('nearpacks.near', kp.getPublicKey(), 'nearpacks.near', nonce,
      [T.actionCreators.functionCall('payout', args, gas, deposit)], auth.base58Decode(blockHash));
    const encoded = T.encodeTransaction(tx);
    const hash = crypto.createHash('sha256').update(encoded).digest();
    const sig = kp.sign(hash);
    const signed = new T.SignedTransaction({ transaction: tx, signature: new T.Signature({ keyType: 0, data: sig.signature }) });

    assert.equal(ours.signed.toString('hex'), Buffer.from(signed.encode()).toString('hex'));
    assert.equal(ours.hash, auth.base58Encode(hash));
  }
});

test('secret keys are validated', () => {
  assert.throws(() => nearTx.parseSecretKey('nope'), /ed25519/);
  const seed = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);
  assert.throws(() => nearTx.parseSecretKey('ed25519:' + auth.base58Encode(Buffer.concat([seed, other]))), /do not match/);
  assert.ok(nearTx.parseSecretKey('ed25519:' + auth.base58Encode(seed)).publicKeyString.startsWith('ed25519:'));
  assert.throws(() => nearTx.u128(-1n), /range/);
});

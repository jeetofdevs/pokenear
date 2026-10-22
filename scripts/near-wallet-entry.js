/* Entry for vendor/near-wallet.js (bundled by `npm run build:near`).
   Exposes window.PNNear: a thin wrapper around NEAR Wallet Selector for sign-in (signMessage)
   and for paying rips in NEAR (rip() on the Pokenear contract, forwarded to the treasury). */
import { Buffer } from 'buffer';
import { setupWalletSelector, actionCreators } from '@near-wallet-selector/core';
import { setupHotWallet } from '@near-wallet-selector/hot-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupSender } from '@near-wallet-selector/sender';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { KeyPairEd25519, PublicKey } from '@near-js/crypto';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

let selector = null;

async function init(network) {
  if (!selector) {
    selector = await setupWalletSelector({
      network: network || 'mainnet',
      modules: [setupHotWallet(), setupMeteorWallet(), setupMyNearWallet(), setupSender(), setupIntearWallet()]
    });
  }
  return selector.store.getState().modules.map((m) => ({
    id: m.id,
    name: m.metadata.name,
    iconUrl: m.metadata.iconUrl,
    available: m.metadata.available !== false,
    type: m.type
  }));
}

// NEP-413 signed message: { accountId, publicKey, signature }.
async function signIn(walletId, params) {
  if (!selector) await init();
  const wallet = await selector.wallet(walletId);
  if (!wallet.signMessage) throw new Error('This wallet cannot sign messages. Pick another NEAR wallet.');
  return wallet.signMessage({
    message: params.message,
    recipient: params.recipient,
    nonce: Buffer.from(params.nonceHex, 'hex'),
    callbackUrl: params.callbackUrl
  });
}

// Pay for a rip in NEAR: either a plain transfer to the treasury (direct mode) or rip({seed, pack,
// count}) on the Pokenear contract with the price attached. The contract draws the randomness and forwards the NEAR to the treasury in the same
// transaction. Returns { tx }, or nothing when the wallet redirects away (the rip resumes on return).
async function pay(walletId, params) {
  if (!selector) await init();
  const wallet = await selector.wallet(walletId);
  let accounts = await wallet.getAccounts().catch(() => []);
  if (!accounts || !accounts.length) accounts = (await wallet.signIn({ contractId: params.receiverId, methodNames: [] })) || [];
  const signerId = params.accountId || (accounts[0] && accounts[0].accountId);
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: params.receiverId,
    actions: [params.method === 'transfer'
      ? actionCreators.transfer(BigInt(params.deposit))
      : actionCreators.functionCall(params.method || 'open_pack', params.args, BigInt('50000000000000'), BigInt(params.deposit))]
  });
  if (!outcome) return null;
  return { tx: outcome.transaction_outcome ? outcome.transaction_outcome.id : (outcome.transaction && outcome.transaction.hash) || null };
}

// Admin (interaction wallet only): a fresh payout key, generated in this browser.
function newKeyPair() {
  const kp = KeyPairEd25519.fromRandom();
  return { secret: kp.toString(), publicKey: kp.getPublicKey().toString() };
}

// Admin: sign and send one transaction from the interaction wallet. actions:
//   { type: 'call', method, args, gas, deposit }      deposit/gas as strings (yocto / gas units)
//   { type: 'addKey', publicKey, receiverId, methods, allowance }
//   { type: 'deploy', code }                           code: Uint8Array of the contract WASM
async function send(walletId, params) {
  if (!selector) await init();
  const wallet = await selector.wallet(walletId);
  const actions = buildActions(params.actions);
  const outcome = await wallet.signAndSendTransaction({ signerId: params.signerId, receiverId: params.receiverId, actions });
  if (!outcome) return null;
  return { tx: outcome.transaction_outcome ? outcome.transaction_outcome.id : (outcome.transaction && outcome.transaction.hash) || null };
}

function buildActions(list) {
  return list.map((a) => {
    if (a.type === 'call') return actionCreators.functionCall(a.method, a.args || {}, BigInt(a.gas || '30000000000000'), BigInt(a.deposit || '0'));
    if (a.type === 'addKey') return actionCreators.addKey(PublicKey.from(a.publicKey), actionCreators.functionCallAccessKey(a.receiverId, a.methods, BigInt(a.allowance)));
    if (a.type === 'deploy') return actionCreators.deployContract(a.code);
    throw new Error('Unknown action ' + a.type);
  });
}

globalThis.PNNear = { init, signIn, pay, newKeyPair, send, buildActions };

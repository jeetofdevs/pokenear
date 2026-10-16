/* Entry for vendor/near-wallet.js (bundled by `npm run build:near`).
   Exposes window.PNNear: a thin wrapper around NEAR Wallet Selector for sign-in (signMessage)
   and for the on-chain RNG call draw(seed) on the Pokenear RNG contract. */
import { Buffer } from 'buffer';
import { setupWalletSelector, actionCreators } from '@near-wallet-selector/core';
import { setupHotWallet } from '@near-wallet-selector/hot-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupSender } from '@near-wallet-selector/sender';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';

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

// Call draw(seed) on the RNG contract from the player's account. Returns the transaction
// outcome, or nothing when the wallet redirects away (MyNearWallet); the rip resumes on return.
async function draw(walletId, params) {
  if (!selector) await init();
  const wallet = await selector.wallet(walletId);
  let accounts = await wallet.getAccounts().catch(() => []);
  if (!accounts || !accounts.length) accounts = (await wallet.signIn({ contractId: params.contractId, methodNames: [] })) || [];
  const signerId = params.accountId || (accounts[0] && accounts[0].accountId);
  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: params.contractId,
    actions: [actionCreators.functionCall('draw', { seed: params.seedHex }, BigInt('30000000000000'), BigInt(params.depositYocto))]
  });
  if (!outcome) return null;
  return { tx: outcome.transaction_outcome ? outcome.transaction_outcome.id : (outcome.transaction && outcome.transaction.hash) || null };
}

globalThis.PNNear = { init, signIn, draw };

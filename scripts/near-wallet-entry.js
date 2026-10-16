/* Entry for vendor/near-wallet.js (bundled by `npm run build:near`).
   Exposes window.PNNear: a thin wrapper around NEAR Wallet Selector used only for
   sign-in. Pokenear never asks NEAR wallets to send a transaction. */
import { Buffer } from 'buffer';
import { setupWalletSelector } from '@near-wallet-selector/core';
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

globalThis.PNNear = { init, signIn };

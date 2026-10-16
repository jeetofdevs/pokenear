/* Entry for vendor/solana-vrf.js (bundled by `npm run build:solana`).
   Exposes window.PNSolVrf.request(): asks ORAO VRF (Solana) for randomness for a rip seed,
   paid and signed by the player's wallet. Pokenear's server then reads the fulfilled
   randomness from chain and derives the cards. */
import { Buffer } from 'buffer';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { Orao, randomnessAccountAddress } from '@orao-network/solana-vrf';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// provider: an injected wallet (Phantom, Solflare, Backpack). rpc: Solana RPC URL.
async function request({ provider, rpc, seedHex }) {
  const connection = new Connection(rpc, 'confirmed');
  const seed = Buffer.from(seedHex, 'hex');
  const account = randomnessAccountAddress(seed).toBase58();
  // A retry after a failed page load: the request may already be on chain.
  if (await connection.getAccountInfo(new PublicKey(account))) return { account, tx: null, existing: true };
  const owner = new PublicKey(provider.publicKey.toBase58());
  const readOnly = { publicKey: owner, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
  const vrf = new Orao(new AnchorProvider(connection, readOnly, { commitment: 'confirmed' }));
  const tx = await (await (await vrf.request(seed)).build()).transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  // The wallet signs; we send and confirm over plain HTTP (works on RPCs without websockets).
  const signed = await provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
  for (let i = 0; i < 60; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw new Error('The randomness request failed on Solana: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  const tx_ = sig;
  return { account, tx: tx_ };
}

globalThis.PNSolVrf = { request };

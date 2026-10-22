'use strict';
/* Solana JSON-RPC helpers for SOL pack payments (no dependencies).
   A pack is paid with one plain SOL transfer from the player to the treasury. The server reads
   that transaction back, checks it, and takes the randomness from the hash of the block (slot)
   that included it, which nobody knows before the transaction lands. */

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('Solana RPC HTTP ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error('Solana RPC: ' + (json.error.message || JSON.stringify(json.error)));
  return json.result;
}

// A confirmed SOL payment: { status: 'pending' | 'failed' | 'ok', signer, transfers, slot, blockTime }.
// transfers lists the top-level System Program transfers: { source, destination, lamports }.
async function solTransferTx(url, signature) {
  const r = await rpc(url, 'getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!r) return { status: 'pending' };
  if (!r.meta || r.meta.err) return { status: 'failed' };
  const msg = r.transaction && r.transaction.message;
  const keys = (msg && msg.accountKeys) || [];
  const signer = keys[0] && (keys[0].pubkey || keys[0]);
  const transfers = ((msg && msg.instructions) || [])
    .filter((ix) => ix.program === 'system' && ix.parsed && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferWithSeed'))
    .map((ix) => ({ source: ix.parsed.info.source, destination: ix.parsed.info.destination, lamports: String(ix.parsed.info.lamports) }));
  return { status: 'ok', signer: String(signer || ''), transfers, slot: r.slot, blockTime: r.blockTime || null };
}

// Hash of the block produced in `slot` (base58).
async function solBlockhash(url, slot) {
  const b = await rpc(url, 'getBlock', [slot, { commitment: 'confirmed', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!b || !b.blockhash) throw new Error('Solana block ' + slot + ' not found');
  return { blockhash: b.blockhash, blockTime: b.blockTime || null };
}

// Recent blockhash for a new transaction (the wallet signs it within ~1 minute).
async function solLatestBlockhash(url) {
  const r = await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
}

// Lamports on an address.
async function solBalance(url, address) {
  const r = await rpc(url, 'getBalance', [address, { commitment: 'confirmed' }]);
  return String(r.value);
}

module.exports = { rpc, solTransferTx, solBlockhash, solLatestBlockhash, solBalance };

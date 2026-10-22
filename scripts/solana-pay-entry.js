// Browser bundle (vendor/solana-pay.js): builds one SOL transfer and has the player's wallet
// (Phantom, Solflare, Backpack) sign and send it. Build: npm run build:sol-pay
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

window.PNSolPay = {
  // -> transaction signature (base58)
  async pay(provider, { from, to, lamports, blockhash, lastValidBlockHeight }) {
    const payer = new PublicKey(from);
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(to), lamports: BigInt(lamports) }));
    if (!provider.signAndSendTransaction) throw new Error('This wallet cannot send transactions.');
    const out = await provider.signAndSendTransaction(tx);
    const sig = typeof out === 'string' ? out : out && out.signature;
    if (!sig) throw new Error('The wallet did not return a transaction signature.');
    return typeof sig === 'string' ? sig : base58(sig);
  }
};

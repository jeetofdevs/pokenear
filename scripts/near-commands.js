#!/usr/bin/env node
/* Prints the NEAR CLI commands to launch Near Packs (the admin page at #admin does the same steps
   with wallet approvals). Players pay in NEAR; the contract forwards payments to the treasury.
   Usage: node scripts/near-commands.js <USD_PER_NEAR> [account] [treasury]
   e.g.   node scripts/near-commands.js 2.50 */
const D = require('../js/data.js');
const [usdPerNear, accountArg, treasuryArg] = process.argv.slice(2);
const prices = usdPerNear && D.packPricesRaw(usdPerNear, 24);
if (!prices) {
  console.error('Usage: node scripts/near-commands.js <USD_PER_NEAR> [account=' + D.GAME_ACCOUNT + '] [treasury=' + D.TREASURY + ']');
  process.exit(1);
}
const account = accountArg || D.GAME_ACCOUNT;
const treasury = treasuryArg || D.TREASURY;
const args = (o) => "'" + JSON.stringify(o) + "'";
const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toString();
console.log(`# Packs at $${usdPerNear}/NEAR: ${D.PACKS.map((p, i) => `${p.name} $${p.usd} = ${near(prices[i])} NEAR`).join(', ')}
# 1. Deploy the Near Packs contract on ${account} (once); payments go to ${treasury}:
near deploy ${account} contracts/near-rng/res/nearpacks_game.wasm --initFunction new --initArgs ${args({ owner: account, treasury, prices })}
# 2. Update prices when the NEAR price moves:
near call ${account} set_prices ${args({ prices })} --accountId ${account}
# 3. Buyback payouts: run "npm run payout-key" (or use the admin page), then add the printed key.
# 4. Keep NEAR on ${account} for contract storage (~3 NEAR) and buybacks.`);

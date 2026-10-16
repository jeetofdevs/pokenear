#!/usr/bin/env node
/* Prints the NEAR CLI commands to launch $POKENEAR payments on the interaction wallet.
   Usage: node scripts/near-commands.js <TOKEN_CA> <USD_PER_TOKEN> [decimals] [account]
   e.g.   node scripts/near-commands.js pokenear.tkn.near 0.01 18
   Pack prices are the USD price of each pack converted to the token's smallest unit. */
const D = require('../js/data.js');
const [ca, usdPerToken, decimalsArg, accountArg] = process.argv.slice(2);
if (!ca || !usdPerToken) {
  console.error('Usage: node scripts/near-commands.js <TOKEN_CA> <USD_PER_TOKEN> [decimals=18] [account=' + D.GAME_ACCOUNT + ']');
  process.exit(1);
}
const decimals = Number(decimalsArg || 18);
const account = accountArg || D.GAME_ACCOUNT;
const prices = D.packPricesRaw(usdPerToken, decimals);
if (!prices) { console.error('USD_PER_TOKEN must be a positive decimal number'); process.exit(1); }
const args = (o) => "'" + JSON.stringify(o) + "'";
console.log(`# Packs: ${D.PACKS.map((p, i) => `${p.name} $${p.usd} = ${prices[i]} (raw)`).join(', ')}
# 1. Deploy the Pokenear contract on the interaction wallet (once):
near deploy ${account} contracts/near-rng/res/pokenear_game.wasm --initFunction new --initArgs ${args({ owner: account, token: ca, prices })}
# 2. Register the interaction wallet with the token so it can receive $POKENEAR (skip if it already holds some):
near call ${ca} storage_deposit ${args({ account_id: account, registration_only: true })} --accountId ${account} --deposit 0.0125
# 3. Already deployed? Set or change the CA and prices:
near call ${account} set_token ${args({ token: ca })} --accountId ${account}
near call ${account} set_prices ${args({ prices })} --accountId ${account}
# 4. Buyback payouts: add a key that can only call payout(), then put its secret in PAYOUT_KEY on the server:
near generate-key pokenear-payout
near add-key ${account} <PUBLIC_KEY_FROM_STEP_4> --contract-id ${account} --method-names payout --allowance 1
# 5. Keep a few NEAR on ${account} for draw storage and payout gas.`);

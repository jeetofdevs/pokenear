#!/usr/bin/env node
/* Creates the buyback payout key on THIS machine and stores it in .env as PAYOUT_KEY.
   The secret never leaves the machine and is never printed. Afterwards it prints the one
   command the owner of the interaction wallet runs to allow this key to call payout() only.

   Usage: npm run payout-key [-- --force] [-- --env path/to/.env]
          --force  replace an existing PAYOUT_KEY (remove the old key from the account too) */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../js/auth.js');
const D = require('../js/data.js');

const args = process.argv.slice(2);
const force = args.includes('--force');
const envIndex = args.indexOf('--env');
const envFile = path.resolve(envIndex >= 0 ? args[envIndex + 1] : path.join(__dirname, '..', '.env'));

let text = '';
try { text = fs.readFileSync(envFile, 'utf8'); } catch { /* new file */ }
const env = Object.fromEntries(text.split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const account = env.GAME_ACCOUNT || D.GAME_ACCOUNT;
const network = env.NEAR_NETWORK || 'mainnet';

if (env.PAYOUT_KEY && !force) {
  const pub = 'ed25519:' + auth.base58Encode(auth.base58Decode(env.PAYOUT_KEY.replace(/^ed25519:/, '')).slice(32));
  console.log(`PAYOUT_KEY already exists in ${envFile} (public key ${pub}).`);
  console.log('Run with --force to replace it (then delete the old key from the account).');
  process.exit(0);
}

// NEAR secret key format: "ed25519:" + base58(seed 32 bytes || public key 32 bytes)
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const secret = 'ed25519:' + auth.base58Encode(Buffer.concat([seed, pub]));
const publicKeyStr = 'ed25519:' + auth.base58Encode(pub);

const line = `PAYOUT_KEY=${secret}`;
const next = /^\s*PAYOUT_KEY\s*=.*$/m.test(text)
  ? text.replace(/^\s*PAYOUT_KEY\s*=.*$/m, line)
  : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
fs.writeFileSync(envFile, next, { mode: 0o600 });
try { fs.chmodSync(envFile, 0o600); } catch { /* not supported on this filesystem */ }

console.log(`Saved PAYOUT_KEY in ${envFile} (secret not shown; keep this file private).

Public key: ${publicKeyStr}

Now allow it on ${account}, signed by ${account} (it can ONLY call payout()):

  near add-key ${account} ${publicKeyStr} --contract-id ${account} --method-names payout --allowance 1 --networkId ${network}

  (near-cli-rs: near account add-key ${account} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${account} --function-names payout use-manually-provided-public-key ${publicKeyStr} network-config ${network} sign-with-keychain send)

Then restart the server; its log should say "buyback on".
To revoke later: near delete-key ${account} ${publicKeyStr} --networkId ${network}`);

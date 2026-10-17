# Pokenear

On-chain Pokémon TCG gacha on NEAR: packs are paid in **NEAR** through the contract on **pokenearfun.near**, which draws the randomness and forwards every payment to the treasury **pokenear.near** in the same transaction.

Players connect a NEAR wallet, rip Pokémon card packs with published odds, keep cards in a vault or sell them back for 96% (paid in NEAR by pokenearfun.near). Every card is derived from the on-chain draw and re-checked in the browser. There are no credits, points, invites or daily rewards: players pay with the NEAR in their wallet.

## Features

- **NEAR wallet sign-in**: HOT, Meteor, MyNearWallet, Sender, Intear via NEAR Wallet Selector (bundled in `vendor/near-wallet.js`). The wallet signs a NEP-413 message (no transaction, no fee); the server verifies it and checks the key is a full-access key of the account.
- **Tiered packs, one card per rip**, priced in USD and paid in NEAR (the NEAR amount is set on chain and follows the NEAR price). Each tier has its own value band so every pack has different chase cards:

  | Pack | Price | Card values in pool |
  | --- | --- | --- |
  | Starter | **$10** | $2 – $70 |
  | Rare | $25 | $9 – $130 |
  | Elite | $50 | $12 – $230 |
  | Legend | $100 | $34 – $320 |

- **Published odds for every card.** Each card gets weight `value^-k`; `k` is solved so the pack's expected value is 98% of its price (`EV_RATIO`).
- **Buyback at 96%** (`BUYBACK_RATE`) of a card's value, paid in NEAR from pokenearfun.near at the same rate as the pack prices.
- **Dev wallet**: `pokenearfun.near` (`DEV_ACCOUNTS`) rips without paying; its rips use server randomness and are recorded like any other (vault, history, ranks, database), marked as dev rips.
- **Real cards**: 740 Pokémon TCG cards from Scarlet & Violet 151, Mega Evolution, Black Bolt and White Flare (TCGdex data). Black White Rare, Mega Hyper Rare and gold Hyper Rare cards use the drawn card art (their etched-foil scans look washed out on screen). Every Pokémon has artwork: dream-world sprites up to Gen 5, PokeAPI official artwork for newer Pokémon (`npm run build:cards` downloads it once into `.cache/`).
- **Docs** at `#docs` and a leaderboard by vault value. Official X: [@pokenearfun](https://x.com/pokenearfun).

## Going live (direct mode)

Packs open as soon as the server knows the NEAR price; no contract is needed for that. The server reads NEAR/USD live (median of Binance, CoinGecko and Kraken, cached 30 s; `NEAR_PRICE_URL` overrides, and admins can save a backup price) and quotes every rip at that moment's price. Without the contract, the player sends exactly that NEAR to **pokenear.near** (`TREASURY`); the server checks the transaction on chain (sender, receiver, exact amount, success, sent after the rip started, never reused) and derives `randomness = sha256("pokenear-transfer:v1" || block hash || seed)` from the block that included it. Buybacks turn on after the contract is deployed. Admin wallets: pokenearfun.near and pokenear.near (`ADMIN_ACCOUNTS`).

## Payments and on-chain RNG

1. `POST /api/rip/start` issues a one-time 32-byte `seed` and returns what to pay: `{ method: 'rip', receiver: pokenearfun.near, deposit, args: {seed, pack, count} }`. Prices (yoctoNEAR) come from the contract (`get_config`).
2. The player's wallet calls `rip({seed, pack, count})` on pokenearfun.near with exactly `price[pack] × count` NEAR attached. The contract mixes `env::random_seed()` with the seed, the player and the block height, stores the draw, and forwards the NEAR to the treasury **pokenear.near** in the same transaction. Any mismatch panics, so the player's NEAR is returned.
3. `POST /api/rip/finish` reads `get_draw(seed)` (202 until it exists), checks it was this player's payment for this pack and count, and derives the cards:

   ```
   h_i = sha256("pokenear-rip:v1" || randomness || seed || byte(i)),  u_i = first 6 bytes / 2^48
   card_i = first card in the pack list whose cumulative chance > u_i
   ```

4. The browser re-derives the cards and shows the proof with NearBlocks links. `POST /api/rip/cancel` drops a rip only while nothing was paid for its seed.
5. `POST /api/buyback` sends `payout(receiver, amount, ref_id)` to pokenearfun.near, signed with `PAYOUT_KEY` (a function-call key limited to `payout`). The contract pays NEAR from its own balance (keeping its storage stake plus 0.5 NEAR), each `ref_id` pays once, and cards leave the vault only after the payout succeeds.

### Launch from the admin page (no terminal)

Log in to the site with **pokenearfun.near** and open **Admin** (`#admin`, only shown to that wallet). Each step is one transaction your wallet approves; the server never holds the wallet's keys:

1. **Deploy** the Pokenear contract (treasury pokenear.near is set at deploy). If your wallet cannot deploy from a website, the page shows the one CLI command instead.
2. **Prices**: enter the USD price of 1 NEAR, calculate, save. Packs open for players right away. Update when the NEAR price moves.
3. **Treasury**: shows that payments go to pokenear.near (and can switch it if needed).
4. **Buyback key**: generated in your browser and shown once. Paste it into your hosting as `PAYOUT_KEY`, approve adding it (it can only call `payout`), redeploy. Keep NEAR on pokenearfun.near for buybacks.

CLI alternative: `node scripts/near-commands.js <USD_PER_NEAR>` prints the same steps as NEAR CLI commands.

Contract tests and build:

```bash
cd contracts/near-rng
cargo +stable test                                       # 15 unit tests
cargo build --release --target wasm32-unknown-unknown    # toolchain 1.81 (rust-toolchain.toml); prebuilt: res/pokenear_game.wasm
```

## Run it

```bash
npm start            # http://localhost:3000 (verified wallet sign-in, game state in data/db.json)
npm test             # engine, on-chain decoding, transaction signing and server tests
```

The server runs on Node 18+ and has no runtime dependencies (no `npm install` needed to run it). Settings (`.env`):

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | (empty) | Set to your `https://` URL so the session cookie is `Secure` |
| `NEAR_NETWORK` | `mainnet` | `testnet` for NEAR testnet (also set `nearNetwork` in `index.html`) |
| `NEAR_RPC` | FastNEAR, then near.org | NEAR RPC URL(s), comma separated |
| `GAME_ACCOUNT` | `pokenearfun.near` | Interaction wallet running the Pokenear contract |
| `PAYOUT_KEY` | (empty) | `ed25519:...` function-call key of `GAME_ACCOUNT` for `payout`; empty = buyback closed |
| `DEV_ACCOUNTS` | `pokenearfun.near` | Wallets that rip without paying (recorded as dev rips) |
| `DB_FILE` | `data/db.json` | Where game state is stored |

Opened as static files (no server), the site runs in **demo mode**: rips are free and use browser randomness, progress stays in the browser, and a "demo wallet" button lets people try it without a wallet.

Rebuild generated files with `npm install` then `npm run build:cards` (card data and art) or `npm run build:near` (NEAR wallet bundle, including the `rip` payment).

## Brand

`assets/brand/` holds the Pokenear brand kit:

| File | Use |
| --- | --- |
| `pokenear-logo.svg` / `.png` | Wordmark with the orb as the O and the "Trading Card Gacha" ribbon (vector outlines, no font needed) |
| `pokenear-icon.svg` / `.png` | The orb: collector ball with the NEAR symbol in the centre button. Site favicon and topbar icon |
| `x-profile.png` | 400×400 X profile picture |
| `x-header.png` | 1500×500 X header (source: `x-header.html`) |
| `x-post.png` | 1600×900 X post image (source: `x-post.html`) |
| `x-first-post.png` | Launch-day first post: same image with a "Live on NEAR" badge (`x-post.html?first`) |

Rebuild with `npm run build:brand` (logo, icon, profile) `npm run build:x-header` and `npm run build:x-post` (need Playwright + Chromium).

## Layout

| Path | What |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles |
| `js/cards.js`, `assets/art/` | Generated real card data and artwork (`npm run build:cards`) |
| `scripts/build-cards.js` | Builds them from TCGdex and PokéAPI sprites |
| `js/data.js` | Card values, packs and odds, interaction wallet |
| `js/engine.js` | Game rules (rips from on-chain randomness, buyback). Shared by browser and server |
| `js/auth.js` | Sign-in message, base58, address checks (browser + server) |
| `js/wallets.js` | NEAR Wallet Selector bridge: sign-in and rip payments |
| `vendor/near-wallet.js` | Bundled NEAR Wallet Selector (`scripts/near-wallet-entry.js`) |
| `js/store.js` | Picks live server or local demo backend |
| `js/app.js` | UI |
| `js/sha256.js` | SHA-256 used to derive cards (browser + server) |
| `server/server.js`, `server/wallet-verify.js` | Static files, wallet sign-in and signature checks, game API |
| `server/onchain.js` | NEAR view calls: contract config, draws, token metadata and balances |
| `server/near-tx.js` | Dependency-free NEAR transaction signer for buyback payouts |
| `contracts/near-rng/` | Pokenear contract for pokenearfun.near: NEAR payments forwarded to pokenear.near, randomness, payouts (Rust, near-sdk 5.11) |
| `tests/` | `node --test` suites |

## Notes before launch

- Pokémon card names, art and scans belong to Nintendo / The Pokémon Company. A public launch with a token needs a licence or a physical-card model.
- The logo uses the NEAR symbol. Check the NEAR Foundation brand guidelines before using it publicly, and avoid implying an official partnership.

- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- Each rip costs the player the pack price in NEAR plus gas; draw storage is paid from pokenearfun.near's NEAR balance.
- NEAR's `random_seed` comes from block producers; a producer could in theory withhold a block. Fine for these card values; use a VRF oracle on NEAR if stakes grow.
- Solana sign-in and the ORAO VRF code (`server/onchain.js`, `scripts/solana-vrf-entry.js`) are kept but switched off, since payments run on NEAR.

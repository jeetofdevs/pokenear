# StonkPacks

Open real Pokémon card packs with **SOL** on Solana. The StonkPacks token launches on [StonkFun](https://www.stonkfun.xyz/).

- **Payments:** one plain SOL transfer from the player to the treasury wallet (`TREASURY_SOL`), at the live SOL/USD price (median of Binance, CoinGecko, Kraken, Coinbase, OKX, Bybit), rounded up to 0.0001 SOL.
- **Verification:** the server reads the transaction from Solana RPC (signed by the player, exact lamports to the treasury, succeeded, sent after the pack started, never reused).
- **Randomness:** `sha256("stonkpacks-sol:v1" || hash of the block that includes the payment || seed)`; cards: `sha256("stonkpacks-open:v1" || randomness || seed || i)`. The browser re-checks every pull.
- **Wallets:** Phantom, Solflare, Backpack (sign-in is one signed message, no transaction).
- **Owner:** the treasury wallet opens packs free (recorded as owner openings) and sees `/admin` (treasury balance, SOL price, backup price).
- **Not live yet on Solana:** the 96% buyback (needs a payout wallet; the button reads "Buyback soon").

Set `TREASURY_SOL` (env, or `TREASURY_SOL` in `js/data.js`) to open packs. `CHAIN=near` switches back to the NEAR setup described below.

---
# Near Packs

On-chain Pokémon TCG gacha on NEAR: packs are paid in **NEAR** through the contract on **nearpacks.near**, which draws the randomness and forwards every payment to the treasury **nearpacks.near** in the same transaction.

Players connect a NEAR wallet, open Pokémon card packs with published odds, keep cards in a vault or sell them back for 96% (paid in NEAR by nearpacks.near). Every card is derived from the on-chain draw and re-checked in the browser. There are no credits, points, invites or daily rewards: players pay with the NEAR in their wallet.

## Features

- **NEAR wallet sign-in**: HOT, Meteor, MyNearWallet, Sender, Intear via NEAR Wallet Selector (bundled in `vendor/near-wallet.js`). The wallet signs a NEP-413 message (no transaction, no fee); the server verifies it and checks the key is a full-access key of the account.
- **Tiered packs, one card per pack**, priced in USD and paid in NEAR (the NEAR amount is set on chain and follows the NEAR price). Every Pokémon is in exactly one pack (Pokémon cards only, one print each), so every pack has its own cards:

  | Pack | Price | Card values in pool |
  | --- | --- | --- |
  | Starter | **$10** | $2 – $70 |
  | Rare | $25 | $9 – $130 |
  | Elite | $50 | $12 – $230 |
  | Legend | $100 | $34 – $320 |

- **Published odds for every card.** Each card gets weight `value^-k`; `k` is solved so the pack's expected value is 98% of its price (`EV_RATIO`).
- **Buyback at 96%** (`BUYBACK_RATE`) of a card's value, paid in NEAR from nearpacks.near at the same rate as the pack prices.
- **Dev wallet**: `nearpacks.near` (`DEV_ACCOUNTS`) opens packs without paying; its openings use server randomness and are recorded like any other (vault, history, ranks, database), marked as dev openings.
- **Real cards**: 740 Pokémon TCG cards from Scarlet & Violet 151, Mega Evolution, Black Bolt and White Flare (TCGdex data). Black White Rare, Mega Hyper Rare and gold Hyper Rare cards use the drawn card art (their etched-foil scans look washed out on screen). Every Pokémon has artwork: dream-world sprites up to Gen 5, PokeAPI official artwork for newer Pokémon (`npm run build:cards` downloads it once into `.cache/`).
- **Docs** at `/docs` and a leaderboard by vault value. Official X: [@NearPacks](https://x.com/NearPacks).

## Going live (direct mode)

Packs open as soon as the server knows the NEAR price; no contract is needed for that. The server reads NEAR/USD live (median of Binance, CoinGecko and Kraken, cached 30 s; `NEAR_PRICE_URL` overrides, and admins can save a backup price) and quotes every pack at that moment's price. Without the contract, the player sends exactly that NEAR to **nearpacks.near** (`TREASURY`); the server checks the transaction on chain (sender, receiver, exact amount, success, sent after the pack was started, never reused) and derives `randomness = sha256("nearpacks-transfer:v1" || block hash || seed)` from the block that included it. Buybacks turn on after the contract is deployed. Admin wallet: nearpacks.near (`ADMIN_ACCOUNTS`).

## Payments and on-chain RNG

1. `POST /api/rip/start` issues a one-time 32-byte `seed` and returns what to pay: `{ method: 'open_pack', receiver: nearpacks.near, deposit, args: {seed, pack, count} }`. Prices (yoctoNEAR) come from the contract (`get_config`).
2. The player's wallet calls `open_pack({seed, pack, count})` on nearpacks.near with exactly `price[pack] × count` NEAR attached. The contract mixes `env::random_seed()` with the seed, the player and the block height, stores the draw, and forwards the NEAR to the treasury **nearpacks.near** in the same transaction. Any mismatch panics, so the player's NEAR is returned.
3. `POST /api/rip/finish` reads `get_draw(seed)` (202 until it exists), checks it was this player's payment for this pack and count, and derives the cards:

   ```
   h_i = sha256("nearpacks-open:v1" || randomness || seed || byte(i)),  u_i = first 6 bytes / 2^48
   card_i = first card in the pack list whose cumulative chance > u_i
   ```

4. The browser re-derives the cards and shows the proof with NearBlocks links. `POST /api/rip/cancel` drops a pack only while nothing was paid for its seed.
5. `POST /api/buyback` sends `payout(receiver, amount, ref_id)` to nearpacks.near, signed with `PAYOUT_KEY` (a function-call key limited to `payout`). The contract pays NEAR from its own balance (keeping its storage stake plus 0.5 NEAR), each `ref_id` pays once, and cards leave the vault only after the payout succeeds.

### Launch from the admin page (no terminal)

Log in to the site with **nearpacks.near** and open **Admin** (`/admin`, only shown to that wallet). Each step is one transaction your wallet approves; the server never holds the wallet's keys:

1. **Deploy** the Near Packs contract (treasury nearpacks.near is set at deploy). If your wallet cannot deploy from a website, the page shows the one CLI command instead.
2. **Prices**: enter the USD price of 1 NEAR, calculate, save. Packs open for players right away. Update when the NEAR price moves.
3. **Treasury**: shows that payments go to nearpacks.near (and can switch it if needed).
4. **Buyback key**: generated in your browser and shown once. Paste it into your hosting as `PAYOUT_KEY`, approve adding it (it can only call `payout`), redeploy. Keep NEAR on nearpacks.near for buybacks.

CLI alternative: `node scripts/near-commands.js <USD_PER_NEAR>` prints the same steps as NEAR CLI commands.

Contract tests and build:

```bash
cd contracts/near-rng
cargo +stable test                                       # 15 unit tests
cargo build --release --target wasm32-unknown-unknown    # toolchain 1.81 (rust-toolchain.toml); prebuilt: res/nearpacks_game.wasm
```

## Deploy on Railway

`railway.json` + `Dockerfile`: Railway builds a small Node 20 image (no `npm install`, the server has no runtime dependencies) and runs `node server/server.js`, health check `/api/config`.

1. Railway → **New Project** → **Deploy from GitHub repo** → this repo / branch.
2. Service → **Settings → Volumes** (or right-click the service → **Attach volume**), mount path `/data`. The server stores its database there automatically (`RAILWAY_VOLUME_MOUNT_PATH`); without a volume, data is lost on every redeploy (the log warns).
3. **Variables**: none required. Optional `PAYOUT_KEY` (buyback), `NEAR_USD` (backup price).
4. **Settings → Networking → Custom Domain** → `nearpacks.fun`, then set the DNS record Railway shows (CNAME) at your domain registrar, and remove the domain from Vercel.

## Deploy on Vercel

The site and the game server both run on Vercel: static files are served as is, and every `/api/*` request goes to the serverless function `api/server.js` (same code as `npm start`, see `vercel.json`). Vercel keeps no files between requests, so game data lives in **Upstash Redis** (`server/kv.js`).

1. Vercel project → **Storage** → add a Redis store (Upstash Redis or Redis) and connect it to this project. Any of these work, with or without a name prefix: `KV_REST_API_URL` + `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL` + `_TOKEN`, or `REDIS_URL` / `KV_URL` (redis:// or rediss://). `/api/config` shows `game.storage` (and, when not connected, the names of the Redis variables it can see).
2. Redeploy. `https://<domain>/api/config` must answer JSON with `"mode":"live"`.
3. Optional env vars: `PAYOUT_KEY` (buyback), `NEAR_USD` (backup price).

Without Redis the packs page says "Game database not connected". Requests that change data hold a short Redis lock, so payments are checked one at a time.

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
| `GAME_ACCOUNT` | `nearpacks.near` | Interaction wallet running the Near Packs contract |
| `PAYOUT_KEY` | (empty) | `ed25519:...` function-call key of `GAME_ACCOUNT` for `payout`; empty = buyback closed |
| `DEV_ACCOUNTS` | `nearpacks.near` | Wallets that open packs without paying (recorded as dev openings) |
| `DB_FILE` | `data/db.json` | Where game state is stored |

Without the server the site only shows packs and docs; opening packs always needs the server and a NEAR payment (no demo mode).

Rebuild generated files with `npm install` then `npm run build:cards` (card data and art) or `npm run build:near` (NEAR wallet bundle, including the `open_pack` payment).

## Brand

`assets/brand/` holds the Near Packs brand kit (NEAR green #00ec97, violet #8b7bff, near-black; Space Grotesk + Inter):

| File | Use |
| --- | --- |
| `stonkpacks-icon.svg` / `.png` | Logo icon: a holo-foil booster pack with the NEAR mark. Favicon, top bar, card backs |
| `x-profile.png` | 400×400 X profile picture |
| `x-header.png` | 1500×500 X header (source: `x-header.html`) |
| `x-post.png`, `x-first-post.png` | 1600×900 X post images (source: `x-post.html`, `?first` for the launch badge) |

Rebuild the X images with `npm run build:x-header` and `npm run build:x-post` (need Playwright + Chromium).

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
| `js/store.js` | Talks to the live server (no demo mode) |
| `js/app.js` | UI |
| `js/sha256.js` | SHA-256 used to derive cards (browser + server) |
| `server/server.js`, `server/wallet-verify.js` | Static files, wallet sign-in and signature checks, game API |
| `server/onchain.js` | NEAR view calls: contract config, draws, token metadata and balances |
| `server/near-tx.js` | Dependency-free NEAR transaction signer for buyback payouts |
| `contracts/near-rng/` | Near Packs contract for nearpacks.near: NEAR payments forwarded to nearpacks.near, randomness, payouts (Rust, near-sdk 5.11) |
| `tests/` | `node --test` suites |

## Notes before launch

- Pokémon card names, art and scans belong to Nintendo / The Pokémon Company. A public launch with a token needs a licence or a physical-card model.
- The logo uses the NEAR symbol. Check the NEAR Foundation brand guidelines before using it publicly, and avoid implying an official partnership.

- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- Each rip costs the player the pack price in NEAR plus gas; draw storage is paid from nearpacks.near's NEAR balance.
- NEAR's `random_seed` comes from block producers; a producer could in theory withhold a block. Fine for these card values; use a VRF oracle on NEAR if stakes grow.
- Solana sign-in and the ORAO VRF code (`server/onchain.js`, `scripts/solana-vrf-entry.js`) are kept but switched off, since payments run on NEAR.

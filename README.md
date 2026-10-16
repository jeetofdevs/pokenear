# Pokenear

On-chain Pokémon TCG gacha with Solana / NEAR wallet sign-in, on-chain randomness, instant buyback and invite links.

Players connect a wallet, rip Pokémon card packs with published odds, sell pulls back instantly and invite friends. Every card is derived from on-chain randomness (ORAO VRF on Solana, the Pokenear RNG contract on NEAR) and re-checked in the browser. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

## Features

Same model as Courtyard, Collector Crypt and Phygitals:

- **Wallet sign-in first.** Nothing is playable until a wallet is connected:
  - **Solana**: Phantom, Solflare, Backpack (injected providers; mobile users get an "Open in app" link).
  - **NEAR**: HOT, Meteor, MyNearWallet, Sender, Intear via NEAR Wallet Selector (bundled in `vendor/near-wallet.js`, loaded only when NEAR is chosen).
  - The wallet signs a one-time message (no transaction, no fee). The server verifies it: ed25519 for Solana; NEP-413 for NEAR, plus a NEAR RPC check that the key is a full-access key of the account.
- **Tiered packs, one card per rip**, paid in `$POKENEAR` and priced in USD (`TOKEN_USD` peg in `js/data.js`, placeholder 1 $POKENEAR = $0.01):

  | Pack | Price | Card values in pool |
  | --- | --- | --- |
  | Starter | **$10** | $2 – $120 |
  | Rare | $25 | $9 – $250 |
  | Elite | $50 | $12 – $400 |
  | Legend | $100 | $34 – $1,000 |

- **Published odds for every card.** Each card gets weight `value^-k`; `k` is solved so the pack's expected value is 98% of its price (`EV_RATIO`). Cheaper cards are more likely, chase cards are rare. Each pack also shows the chance to pull at least the price and 3× the price.
- **Instant buyback at 90%** (`BUYBACK_RATE`) of a card's value, right after the rip or later from the vault.
- **Vault**: every pull is a unique item you can hold or sell back. Physical redemption is planned for launch.
- **Real cards**: 740 Pokémon TCG cards from Scarlet & Violet 151, Mega Evolution, Black Bolt and White Flare (TCGdex data).
- **Card values** are estimates (rarity base × card spread × popularity, hand-set for headline cards). Connect a price feed before launch.
- **Invites**: `?ref=CODE` links. New players get +500, inviters get +500 per friend.
- **Daily drop** and a leaderboard by vault value.
- **Docs** at `#docs`: how it works, odds tables, on-chain RNG and verification, fees, FAQ. Official X: [@pokenearfun](https://x.com/pokenearfun).

## On-chain RNG

1. `POST /api/rip/start` reserves the price and issues a one-time 32-byte `seed`.
2. The player's wallet requests randomness for that seed:
   - **Solana**: `request_v2` on ORAO VRF (`VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`); the randomness lands in the PDA `["orao-vrf-randomness-request", seed]` (`vendor/solana-vrf.js`, built from `scripts/solana-vrf-entry.js`).
   - **NEAR**: `draw(seed)` on the `contracts/near-rng` contract with 0.003 NEAR attached.
3. `POST /api/rip/finish` reads the randomness from the chain (`server/onchain.js`; 202 while pending) and derives the cards:

   ```
   h_i = sha256("pokenear-rip:v1" || randomness || seed || byte(i)),  u_i = first 6 bytes / 2^48
   card_i = first card in the pack list whose cumulative chance > u_i
   ```

4. The browser re-derives the cards and shows the proof with explorer links. `POST /api/rip/cancel` refunds only while no randomness exists on chain.

### Deploy the NEAR contract

```bash
cd contracts/near-rng
cargo +stable test --release          # unit tests
cargo build --release --target wasm32-unknown-unknown   # toolchain 1.81 (rust-toolchain.toml); prebuilt: res/pokenear_rng.wasm
near deploy rng.pokenear.near res/pokenear_rng.wasm --initFunction new --initArgs '{}'
```

Then set `NEAR_RNG_CONTRACT=rng.pokenear.near` on the server.

## Run it

```bash
npm start            # http://localhost:3000 (verified wallet sign-in, game state in data/db.json)
npm test             # engine + server tests
```

The server runs on Node 18+, has no runtime dependencies (no `npm install` needed to run it) and needs no API keys. Optional settings (`.env`):

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | (empty) | Set to your `https://` URL so the session cookie is `Secure` |
| `NEAR_NETWORK` | `mainnet` | `testnet` for NEAR testnet (also set `nearNetwork` in `index.html`) |
| `NEAR_RPC` | FastNEAR, then near.org | NEAR RPC URL(s), comma separated, used to confirm account keys and read draws |
| `SOLANA_CLUSTER` | `mainnet-beta` | `devnet` for testing |
| `SOLANA_RPC` | public RPC | Solana RPC the server reads ORAO accounts from (use a paid RPC in production) |
| `SOLANA_PUBLIC_RPC` | `SOLANA_RPC` | RPC handed to browsers for sending the ORAO request |
| `NEAR_RNG_CONTRACT` | (empty) | Account of the deployed `contracts/near-rng` contract |
| `DB_FILE` | `data/db.json` | Where game state is stored |

Opened as static files (no server), the site runs in **demo mode**: progress stays in the browser, wallet signatures are requested but not verified, and a "demo wallet" button lets people try it without a wallet.

To put invite links on your public domain, set `window.PN_CONFIG.siteUrl` in `index.html`.

Rebuild generated files with `npm install` then `npm run build:cards` (card data and art) or `npm run build:near` / `npm run build:solana` (wallet and ORAO bundles).

## Brand

`assets/brand/` holds the Pokenear brand kit:

| File | Use |
| --- | --- |
| `pokenear-logo.svg` / `.png` | Wordmark with the orb as the O and the "Trading Card Gacha" ribbon (vector outlines, no font needed) |
| `pokenear-icon.svg` / `.png` | The orb: collector ball with the NEAR symbol in the centre button. Site favicon and topbar icon |
| `x-profile.png` | 400×400 X profile picture |
| `x-header.png` | 1500×500 X header (source: `x-header.html`) |

Rebuild with `npm run build:brand` (logo, icon, profile) and `npm run build:x-header` (needs Playwright + Chromium).

## Layout

| Path | What |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles |
| `js/cards.js`, `assets/art/` | Generated real card data and artwork (`npm run build:cards`) |
| `scripts/build-cards.js` | Builds them from TCGdex and PokéAPI sprites |
| `js/data.js` | Card values, packs and odds, economy numbers |
| `js/engine.js` | Game rules (rips from on-chain randomness, buyback, rewards). Shared by browser and server |
| `js/auth.js` | Sign-in message, base58, address checks (browser + server) |
| `js/wallets.js` | Solana wallet providers and the NEAR Wallet Selector bridge |
| `vendor/near-wallet.js` | Bundled NEAR Wallet Selector (`scripts/near-wallet-entry.js`) |
| `js/store.js` | Picks live server or local demo backend |
| `js/app.js` | UI |
| `js/sha256.js` | SHA-256 used to derive cards (browser + server) |
| `server/server.js`, `server/wallet-verify.js` | Static files, wallet sign-in and signature checks, game API |
| `server/onchain.js` | Reads ORAO VRF accounts and NEAR draws |
| `contracts/near-rng/` | NEAR RNG contract (Rust, near-sdk 5.11) |
| `tests/` | `node --test` suites |

## Notes before launch

- Pokémon card names, art and scans belong to Nintendo / The Pokémon Company. A public launch with a token needs a licence or a physical-card model.
- The logo uses the NEAR symbol. Check the NEAR Foundation brand guidelines before using it publicly, and avoid implying an official partnership.

- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- Each rip costs the player a chain fee: Solana network fee + ORAO fee, or NEAR gas + 0.003 NEAR storage.
- NEAR's `random_seed` comes from block producers; a producer could in theory withhold a block. Fine for these card values; use a VRF oracle on NEAR if stakes grow.
- `$POKENEAR` balances are points. Connecting them to an on-chain token is a separate step.

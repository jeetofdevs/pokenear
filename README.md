# Pokenear

TCG gacha with Solana / NEAR wallet sign-in, invite links and a `$POKENEAR` whitelist.

Players connect a wallet, rip Pokémon card packs with published odds, sell pulls back instantly, complete quests, invite friends and claim a numbered Season 1 whitelist pass. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

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
- **Whitelist quests**: connect wallet, follow on X, post an invite on X, invite 3 friends, rip your first pack.
- **Invites**: `?ref=CODE` links. New players get +500, inviters get +500 per friend.
- **Daily drop**, season countdown, share-to-X buttons, leaderboard by vault value.

## Run it

```bash
npm start            # http://localhost:3000 (verified wallet sign-in, game state in data/db.json)
npm test             # engine + server tests (Node 18+)
```

The server has no runtime dependencies and needs no API keys. Optional settings (`.env`):

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | (empty) | Set to your `https://` URL so the session cookie is `Secure` |
| `NEAR_NETWORK` | `mainnet` | `testnet` for NEAR testnet (also set `nearNetwork` in `index.html`) |
| `NEAR_RPC` | official RPC | NEAR RPC used to confirm account keys |
| `DB_FILE` | `data/db.json` | Where game state is stored |

Opened as static files (no server), the site runs in **demo mode**: progress stays in the browser, wallet signatures are requested but not verified, and a "demo wallet" button lets people try it without a wallet.

To put invite links on your public domain, set `window.PN_CONFIG.siteUrl` in `index.html`.

Rebuild generated files with `npm install` then `npm run build:cards` (card data and art) or `npm run build:near` (NEAR wallet bundle).

## Layout

| Path | What |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles |
| `js/cards.js`, `assets/art/` | Generated real card data and artwork (`npm run build:cards`) |
| `scripts/build-cards.js` | Builds them from TCGdex and PokéAPI sprites |
| `js/data.js` | Card values, packs and odds, economy numbers, quests |
| `js/engine.js` | Game rules (rips, buyback, rewards, whitelist). Shared by browser and server |
| `js/auth.js` | Sign-in message, base58, address checks (browser + server) |
| `js/wallets.js` | Solana wallet providers and the NEAR Wallet Selector bridge |
| `vendor/near-wallet.js` | Bundled NEAR Wallet Selector (`scripts/near-wallet-entry.js`) |
| `js/store.js` | Picks live server or local demo backend |
| `js/app.js` | UI |
| `server/server.js`, `server/wallet-verify.js` | Static files, wallet sign-in and signature checks, game API |
| `tests/` | `node --test` suites |

## Notes before launch

- Pokémon card names, art and scans belong to Nintendo / The Pokémon Company. A public launch with a token needs a licence or a physical-card model.

- X follow and post quests are self-confirmed. Verifying them needs the paid X API tiers.
- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- `$POKENEAR` balances are points. Connecting them to an on-chain token is a separate step.

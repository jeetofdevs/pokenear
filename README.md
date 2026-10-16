# Pokenear

TCG gacha with X login, invite links and a `$POKENEAR` whitelist.

Players connect X, rip real Pokémon booster packs, complete quests, invite friends and claim a numbered Season 1 whitelist pass. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

## Features

- **X login first.** Nothing is playable until an X account is connected (OAuth 2.0 PKCE on the server).
- **Pokémon TCG live, One Piece coming soon.** 740 real cards from Scarlet & Violet 151, Mega Evolution, Black Bolt and White Flare. One Piece OP-01/05/09/13 show as "Coming soon".
- **Real-money pricing in $POKENEAR.** Prices are set in USD and paid in `$POKENEAR` (`TOKEN_USD` in `js/data.js`, placeholder 1 $POKENEAR = $0.01):
  - Booster Pack: **$10**, 10 cards
  - Booster Bundle: $54, 6 packs
- **Real booster RNG.** Every pack follows the English Scarlet & Violet / Mega Evolution layout: 4 Common, 3 Uncommon, 1 Reverse Holo, 1 Reverse Holo or IR/SIR hit, 1 Rare-or-better slot. Hit odds per pack: SIR 1 in 32, IR 1 in 12, HR 1 in 55, UR 1 in 16, RR 1 in 6, BWR 1 in 300, MUR 1 in 600 (community averages, set in `PACK_SLOTS`). No pity: every pack is an independent roll.
- **Pack opening**: tear the pack, flip 10 cards in pack order, rare-slot glow, reverse-holo foil, bundles open pack by pack.
- **Binder**: per-set completion, sell back duplicates at market-style values, set completion bonus.
- **Whitelist quests**: connect X, follow on X, post an invite on X, invite 3 friends, open your first pack.
- **Invites**: `?ref=CODE` links. New players get +500, inviters get +500 per friend.
- **Daily drop**, season countdown, share-to-X buttons, leaderboard.

## Run it

```bash
npm start            # http://localhost:3000
npm test             # engine + server tests (Node 18+)
```

No dependencies. Without X keys the site runs in **demo mode**: you type an X handle, progress is saved in the browser, and invites can be simulated with a button.

### Enable real X login

1. Create an app at <https://developer.x.com>, turn on OAuth 2.0 (type: Web App), scopes `tweet.read users.read`.
2. Add `http://localhost:3000/auth/x/callback` (or your domain) as a callback URL.
3. `cp .env.example .env` and fill in `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`.
4. `npm start`. The Connect X button now opens X sign-in, and the server:
   - runs every pull and reward server-side (clients cannot edit balances),
   - credits the inviter when a new account signs up with their code,
   - numbers whitelist spots in sign-up order,
   - stores data in `data/db.json`.

To put invite links on your public domain, set `window.PN_CONFIG.siteUrl` in `index.html`.

## Layout

| Path | What |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles |
| `js/cards.js`, `assets/art/` | Generated real card data and artwork (`npm run build:cards`) |
| `scripts/build-cards.js` | Builds them from TCGdex, the One Piece card list and PokéAPI sprites |
| `js/data.js` | Tiers, economy numbers, quests, indexes the card data |
| `js/engine.js` | Game rules (pulls, pity, rewards, whitelist). Shared by browser and server |
| `js/store.js` | Picks live server or local demo backend |
| `js/app.js` | UI |
| `server/server.js` | Static files, X OAuth, game API |
| `tests/` | `node --test` suites |

## Notes before launch

- Pokémon and One Piece card names, art and scans belong to Nintendo / The Pokémon Company and Bandai. A public launch with a token needs a licence or a physical-card model.

- X follow and post quests are self-confirmed. Verifying them needs the paid X API tiers.
- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- `$POKENEAR` balances are points. Connecting them to an on-chain token is a separate step.

# Pokenear

TCG gacha with X login, invite links and a `$POKENEAR` whitelist.

Players connect X, rip Pokémon card packs with published odds, sell pulls back instantly, complete quests, invite friends and claim a numbered Season 1 whitelist pass. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

## Features

Same model as Courtyard, Collector Crypt and Phygitals:

- **X login first.** Nothing is playable until an X account is connected (OAuth 2.0 PKCE on the server).
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
- **Real cards**: 740 Pokémon TCG cards from Scarlet & Violet 151, Mega Evolution, Black Bolt and White Flare (TCGdex data). One Piece is listed as coming soon.
- **Card values** are estimates (rarity base × card spread × popularity, hand-set for headline cards). Connect a price feed before launch.
- **Whitelist quests**: connect X, follow on X, post an invite on X, invite 3 friends, rip your first pack.
- **Invites**: `?ref=CODE` links. New players get +500, inviters get +500 per friend.
- **Daily drop**, season countdown, share-to-X buttons, leaderboard by vault value.

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

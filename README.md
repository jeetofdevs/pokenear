# Pokenear

TCG gacha with X login, invite links and a `$POKENEAR` whitelist.

Players connect X, rip real Pokémon and One Piece booster packs, complete quests, invite friends and claim a numbered Season 1 whitelist pass. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

## Features

- **X login first.** Nothing is playable until an X account is connected (OAuth 2.0 PKCE on the server).
- **8 real booster sets, 1,416 real cards**:
  - Pokémon TCG: Scarlet & Violet 151, Mega Evolution, Black Bolt, White Flare
  - One Piece Card Game: OP-01 Romance Dawn, OP-05 Awakening of the New Era, OP-09 Emperors in the New World, OP-13 Carrying On His Will
  - Real names, numbers, rarities (IR, SIR, HR, BWR, MUR, SEC, parallels…), HP, attacks, power, cost, counter and effects.
- **Card art**: cards are drawn in each game's frame with official Pokémon artwork bundled in `assets/art`. When the host can reach the image CDNs, the official card scan fades in on top (`remoteImages` in `index.html`).
- **Tier rates**: C 60%, R 25%, SR 11%, UR 3.5%, SEC 0.5%. Each real rarity maps to a tier (see the rates table in the app).
- **Pity**: UR or better guaranteed within 60 pulls per series. Every 10-pack holds at least one SR.
- **Pack opening**: tear the pack, flip cards one by one, rarity glow on card backs, holo foil tilt on SR+.
- **Binder**: per-series completion, burn duplicates for `$POKENEAR`, 5,000 `$POKENEAR` set bonus.
- **Whitelist quests**: connect X, follow on X, post an invite on X, invite 3 friends, open 10 cards.
- **Invites**: `?ref=CODE` links. New players get +200, inviters get +250 per friend.
- **Daily drop**, season countdown, share-to-X buttons for pulls and whitelist passes, leaderboard.

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

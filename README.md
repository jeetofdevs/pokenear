# Pokenear

TCG gacha with X login, invite links and a `$POKENEAR` whitelist.

Players connect X, open packs from six card series, complete quests, invite friends and claim a numbered Season 1 whitelist pass. Rewards are paid in `$POKENEAR` (off-chain points until token launch).

## Features

- **X login first.** Nothing is playable until an X account is connected (OAuth 2.0 PKCE on the server).
- **Six gacha series**, 12 cards each (72 total): Pocket Near (flagship creatures), Seven Seas Saga (pirates), Shinobi Clash (ninja), Spirit Blade (slayers), Dragon Orb (fighters), Mecha Frontier (mecha). All names and art are original.
- **Published drop rates**: C 60%, R 25%, SR 11%, UR 3.5%, Secret 0.5%.
- **Pity**: UR or better guaranteed within 60 pulls per series. Every 10-pack holds at least one SR.
- **Pack opening**: tear the pack, flip cards one by one, rarity glow on card backs, holo foil tilt on SR+.
- **Binder**: per-series completion, burn duplicates for `$POKENEAR`, 2,000 `$POKENEAR` set bonus.
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
| `js/data.js` | Rarities, economy numbers, quests, all series and cards |
| `js/engine.js` | Game rules (pulls, pity, rewards, whitelist). Shared by browser and server |
| `js/store.js` | Picks live server or local demo backend |
| `js/app.js` | UI |
| `server/server.js` | Static files, X OAuth, game API |
| `tests/` | `node --test` suites |

## Notes before launch

- X follow and post quests are self-confirmed. Verifying them needs the paid X API tiers.
- `data/db.json` is fine for a pilot. Move to a real database before large traffic.
- `$POKENEAR` balances are points. Connecting them to an on-chain token is a separate step.

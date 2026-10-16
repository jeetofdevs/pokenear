/* Pokenear static game data: rarities, series and cards.
   Shared by the browser (window.PN.data) and the Node server (require). */
(function (root) {
  'use strict';

  var TOKEN = '$POKENEAR';
  var X_HANDLE = 'pokenear';
  var SEASON_END = '2026-11-30T15:00:00Z';

  // Drop rates must sum to 1. Order is lowest -> highest tier.
  var RARITIES = [
    { id: 'C',   name: 'Common',     rate: 0.60,  burn: 5,    power: [40, 90] },
    { id: 'R',   name: 'Rare',       rate: 0.25,  burn: 15,   power: [90, 150] },
    { id: 'SR',  name: 'Super Rare', rate: 0.11,  burn: 50,   power: [150, 220] },
    { id: 'UR',  name: 'Ultra Rare', rate: 0.035, burn: 250,  power: [220, 300] },
    { id: 'SEC', name: 'Secret',     rate: 0.005, burn: 1000, power: [300, 400] }
  ];

  var ECONOMY = {
    startBonus: 1000,       // first X connect
    referredBonus: 200,     // extra for joining through an invite link
    inviteReward: 250,      // paid to the inviter per friend
    dailyReward: 200,
    dailyCooldownMs: 20 * 60 * 60 * 1000,
    singlePrice: 100,
    tenPrice: 900,
    pity: 60,               // guaranteed UR or better within this many pulls per series
    setBonus: 2000,         // complete a series binder
    historySize: 40,
    whitelistInvites: 3,
    whitelistPulls: 10
  };

  // Whitelist quests. `kind: 'x'` quests open an X intent link first.
  var TASKS = [
    { id: 'connect', title: 'Connect your X account', reward: 0, auto: true },
    { id: 'follow', title: 'Follow @' + X_HANDLE + ' on X', reward: 100, kind: 'x' },
    { id: 'post', title: 'Post your invite link on X', reward: 150, kind: 'x' },
    { id: 'invites', title: 'Invite 3 friends', reward: 0, auto: true },
    { id: 'pulls', title: 'Open 10 cards in any series', reward: 0, auto: true }
  ];

  function c(id, name, rarity, art, flavor) {
    return { id: id, name: name, rarity: rarity, art: art, flavor: flavor };
  }

  var SERIES = [
    {
      id: 'pocket', name: 'Pocket Near', tag: 'Flagship', hue: 48,
      blurb: 'Pocket creatures from the Near frontier. The original Pokenear set.',
      cards: [
        c('pocket-01', 'Sparkmouse', 'C', '🐭', 'Stores static in its cheeks.'),
        c('pocket-02', 'Leafling', 'C', '🌱', 'Naps in sunbeams to grow.'),
        c('pocket-03', 'Embercub', 'C', '🦊', 'Its tail flickers when it is happy.'),
        c('pocket-04', 'Bubbletoad', 'C', '🐸', 'Sings bubbles after the rain.'),
        c('pocket-05', 'Pebblet', 'C', '🪨', 'Rolls downhill on purpose.'),
        c('pocket-06', 'Thunderfang', 'R', '🐺', 'Howls and the sky answers.'),
        c('pocket-07', 'Tidalfin', 'R', '🐬', 'Surfs the waves it makes.'),
        c('pocket-08', 'Blazewing', 'R', '🦅', 'Leaves trails of cinders at dawn.'),
        c('pocket-09', 'Psyowl', 'SR', '🦉', 'Sees tomorrow, says nothing.'),
        c('pocket-10', 'Frostdrake', 'SR', '🐉', 'Its breath freezes waterfalls.'),
        c('pocket-11', 'Nearion, Pulse Titan', 'UR', '🦁', 'Guardian of every Near block.'),
        c('pocket-12', 'Genesis Near', 'SEC', '🌌', 'The first spark of the chain.')
      ]
    },
    {
      id: 'seas', name: 'Seven Seas Saga', tag: 'Pirate', hue: 12,
      blurb: 'A pirate crew chasing the last treasure across seven seas.',
      cards: [
        c('seas-01', 'Deckhand Rook', 'C', '⚓', 'Scrubs the deck, dreams of the helm.'),
        c('seas-02', 'Cabin Cook Mira', 'C', '🍖', 'No crew sails hungry on her watch.'),
        c('seas-03', 'Lookout Pip', 'C', '🔭', 'Spots islands before the gulls do.'),
        c('seas-04', 'Gunner Sal', 'C', '💣', 'Counts to three. Usually.'),
        c('seas-05', 'Navigator Wen', 'C', '🧭', 'Reads storms like letters.'),
        c('seas-06', 'Swordsman Kael', 'R', '⚔️', 'Three blades, zero sense of direction.'),
        c('seas-07', 'Sniper Odo', 'R', '🎯', 'Hits the mark from two islands away.'),
        c('seas-08', 'Shipwright Bruno', 'R', '🔨', 'Builds ships that refuse to sink.'),
        c('seas-09', 'Captain Redwake', 'SR', '🏴‍☠️', 'Rival flag on every horizon.'),
        c('seas-10', 'Sea Witch Ondine', 'SR', '🌊', 'Bargains with the tide itself.'),
        c('seas-11', 'Sunhat Captain Rio', 'UR', '👒', 'Laughs loudest when the odds are worst.'),
        c('seas-12', 'The Last Treasure', 'SEC', '💎', 'Everyone wants it. Nobody has seen it.')
      ]
    },
    {
      id: 'shinobi', name: 'Shinobi Clash', tag: 'Ninja', hue: 28,
      blurb: 'Hidden villages, forbidden scrolls and rival clans.',
      cards: [
        c('shinobi-01', 'Leaf Genin', 'C', '🍃', 'Fresh from the academy.'),
        c('shinobi-02', 'Kunai Scout', 'C', '🗡️', 'Silent steps, sharp eyes.'),
        c('shinobi-03', 'Smoke Trickster', 'C', '💨', 'Gone before the smoke clears.'),
        c('shinobi-04', 'Scroll Keeper', 'C', '📜', 'Guards jutsu older than the village.'),
        c('shinobi-05', 'Shadow Double', 'C', '👥', 'Which one is real? Neither.'),
        c('shinobi-06', 'Storm Blade Jin', 'R', '🌩️', 'Lightning in a single strike.'),
        c('shinobi-07', 'Sand Gourd Kazu', 'R', '⏳', 'The desert moves when he does.'),
        c('shinobi-08', 'Mirror Eye Sora', 'R', '👁️', 'Copies any technique once seen.'),
        c('shinobi-09', 'Fox Spirit Host', 'SR', '🦊', 'Carries a storm of nine tails inside.'),
        c('shinobi-10', 'Serpent Sage', 'SR', '🐍', 'Sheds a new skin every century.'),
        c('shinobi-11', 'Sage of the Six Roads', 'UR', '🌀', 'Founder of every clan.'),
        c('shinobi-12', 'Moon Eye Ascendant', 'SEC', '🌕', 'Dreams the world into silence.')
      ]
    },
    {
      id: 'spirit', name: 'Spirit Blade', tag: 'Slayer', hue: 340,
      blurb: 'Breathing-style swordfighters hunting demons after dusk.',
      cards: [
        c('spirit-01', 'Corps Trainee', 'C', '🎋', 'Ten thousand practice swings a day.'),
        c('spirit-02', 'Crow Messenger', 'C', '🐦', 'Shouts orders from the rooftops.'),
        c('spirit-03', 'Wisteria Guard', 'C', '🌸', 'Demons will not cross her path.'),
        c('spirit-04', 'Lantern Keeper', 'C', '🏮', 'Keeps the night roads lit.'),
        c('spirit-05', 'Mask Smith', 'C', '👺', 'Carves a mask for every oath.'),
        c('spirit-06', 'Water Breather Ren', 'R', '💧', 'Flows around every strike.'),
        c('spirit-07', 'Thunder Breather Zen', 'R', '⚡', 'Fast only when terrified.'),
        c('spirit-08', 'Boar Mask Ino', 'R', '🐗', 'Charges first, thinks never.'),
        c('spirit-09', 'Flame Pillar Kyo', 'SR', '🔥', 'Burns brightest at the end.'),
        c('spirit-10', 'Insect Pillar Shino', 'SR', '🦋', 'Smiles, then poisons.'),
        c('spirit-11', 'Sun Dancer', 'UR', '☀️', 'A dance passed down for generations.'),
        c('spirit-12', 'Blood Moon Sovereign', 'SEC', '🩸', 'The night itself bows to him.')
      ]
    },
    {
      id: 'orb', name: 'Dragon Orb', tag: 'Fighter', hue: 200,
      blurb: 'Martial artists breaking power levels for seven wishing orbs.',
      cards: [
        c('orb-01', 'Martial Novice', 'C', '🥋', 'Trains with a turtle shell on.'),
        c('orb-02', 'Turtle Hermit', 'C', '🐢', 'Older than the island he lives on.'),
        c('orb-03', 'Flying Cloud', 'C', '☁️', 'Only pure hearts can ride it.'),
        c('orb-04', 'Capsule Tech', 'C', '💊', 'A whole house in her pocket.'),
        c('orb-05', 'Saibeast', 'C', '🦎', 'Sprouts from the soil, ready to fight.'),
        c('orb-06', 'Ki Blaster Yam', 'R', '💥', 'Fires first, apologises later.'),
        c('orb-07', 'Three-Eye Ten', 'R', '🔱', 'Sees attacks from every angle.'),
        c('orb-08', 'Cyborg K-21', 'R', '🤖', 'Infinite stamina, zero patience.'),
        c('orb-09', 'Prince of Warriors', 'SR', '👑', 'Pride heavier than gravity training.'),
        c('orb-10', 'Green Sage', 'SR', '🧘', 'Regrows anything but patience.'),
        c('orb-11', 'Golden Ascended', 'UR', '🌟', 'Hair of gold, power beyond scouters.'),
        c('orb-12', 'Omega Instinct', 'SEC', '🪐', 'The body moves before the mind.')
      ]
    },
    {
      id: 'mecha', name: 'Mecha Frontier', tag: 'Mecha', hue: 265,
      blurb: 'Giant frames and ace pilots fighting over orbital colonies.',
      cards: [
        c('mecha-01', 'Scout Frame', 'C', '🛰️', 'Eyes on every colony.'),
        c('mecha-02', 'Drone Swarm', 'C', '🛸', 'A thousand sensors, one mind.'),
        c('mecha-03', 'Pilot Cadet', 'C', '🧑‍🚀', 'First sortie, steady hands.'),
        c('mecha-04', 'Repair Bot', 'C', '🔧', 'Fixes armour mid-battle.'),
        c('mecha-05', 'Rail Gunner', 'C', '🔫', 'One shot per orbit.'),
        c('mecha-06', 'Strike Frame Ares', 'R', '🦾', 'Built for close-quarters duels.'),
        c('mecha-07', 'Funnel Ace', 'R', '📡', 'Fights with a dozen floating guns.'),
        c('mecha-08', 'Desert Walker', 'R', '🏜️', 'Treads where wheels fail.'),
        c('mecha-09', 'Scarlet Comet', 'SR', '☄️', 'Three times faster, painted red.'),
        c('mecha-10', 'Zero Wing', 'SR', '✈️', 'Angel wings, demon thrusters.'),
        c('mecha-11', 'Neo Genesis Frame', 'UR', '⚙️', 'Synchronises with its pilot’s soul.'),
        c('mecha-12', 'Celestial Overlord', 'SEC', '🌠', 'Commands the colony fleet alone.')
      ]
    }
  ];

  // Deterministic power from card id so it never changes between sessions.
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  var rarityById = {};
  RARITIES.forEach(function (r, i) { r.tier = i; rarityById[r.id] = r; });

  var cardById = {};
  var seriesById = {};
  SERIES.forEach(function (s) {
    seriesById[s.id] = s;
    s.byRarity = {};
    RARITIES.forEach(function (r) { s.byRarity[r.id] = []; });
    s.cards.forEach(function (card, i) {
      var r = rarityById[card.rarity];
      card.series = s.id;
      card.no = i + 1;
      card.power = r.power[0] + (hash(card.id) % (r.power[1] - r.power[0] + 1));
      cardById[card.id] = card;
      s.byRarity[card.rarity].push(card);
    });
  });

  var data = {
    TOKEN: TOKEN,
    X_HANDLE: X_HANDLE,
    SEASON_END: SEASON_END,
    RARITIES: RARITIES,
    ECONOMY: ECONOMY,
    TASKS: TASKS,
    SERIES: SERIES,
    rarityById: rarityById,
    cardById: cardById,
    seriesById: seriesById,
    hash: hash
  };

  root.PN = root.PN || {};
  root.PN.data = data;
  if (typeof module !== 'undefined' && module.exports) module.exports = data;
})(typeof globalThis !== 'undefined' ? globalThis : this);

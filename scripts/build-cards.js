'use strict';
/* Builds js/cards.js and assets/art/*.webp from real TCG data packages.
   Run: npm run build:cards  (needs the devDependencies installed)
   Sources:
   - Pokémon TCG: @tcgdata/tcgdex-offline (TCGdex cards database)
   - Pokémon artwork: pokeapi-sprites (dream-world SVGs, rendered to WebP). Dream-world stops at
     Gen 5, so newer Pokémon use PokeAPI's official artwork, downloaded once into .cache/. */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const TCGDEX = path.join(NM, '@tcgdata/tcgdex-offline/dist/db/international');
const DREAM = path.join(NM, 'pokeapi-sprites/sprites/pokemon/other/dream-world');
const OFFICIAL = path.join(ROOT, '.cache/official-artwork');
const OFFICIAL_URL = (dex) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;
const ART_DIR = path.join(ROOT, 'assets/art');
const artSource = (dex) => {
  const dream = path.join(DREAM, dex + '.svg');
  if (fs.existsSync(dream)) return { file: dream, density: 120 };
  const official = path.join(OFFICIAL, dex + '.png');
  if (fs.existsSync(official)) return { file: official };
  return null;
};

// Download official artwork for Pokémon without a dream-world sprite (curl honours the proxy env).
async function fetchOfficial(dexes) {
  fs.mkdirSync(OFFICIAL, { recursive: true });
  const { execFileSync } = require('node:child_process');
  for (const dex of dexes) {
    const file = path.join(OFFICIAL, dex + '.png');
    if (fs.existsSync(file) || fs.existsSync(path.join(DREAM, dex + '.svg'))) continue;
    const tmp = file + '.part';
    try {
      execFileSync('curl', ['-sSfL', '-m', '30', '-o', tmp, OFFICIAL_URL(dex)]);
      const meta = await sharp(tmp).metadata(); // must decode as a real PNG
      if (meta.format !== 'png' || !meta.width) throw new Error('not a PNG');
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      console.warn('no artwork for dex', dex, '-', e.message.split('\n')[0]);
    }
  }
}
const OUT = path.join(ROOT, 'js/cards.js');

// Gacha series, newest first within each game.
const POKEMON_SETS = [
  { id: 'mew', set: 'sv03.5', serie: 'sv', name: 'Scarlet & Violet 151', short: '151', hue: 4, tag: 'Trending', cover: 151 },
  { id: 'meg', set: 'me01', serie: 'me', name: 'Mega Evolution', short: 'MEG', hue: 268, tag: 'New', cover: 448 },
  { id: 'blk', set: 'sv10.5b', serie: 'sv', name: 'Black Bolt', short: 'BLK', hue: 222, tag: 'Unova', cover: 644 },
  { id: 'wht', set: 'sv10.5w', serie: 'sv', name: 'White Flare', short: 'WHT', hue: 38, tag: 'Unova', cover: 643 }
];

// Real rarity -> gacha tier (C, R, SR, UR, SEC). Rates per tier live in js/data.js.
const PKM_TIER = {
  'Common': 'C', 'Uncommon': 'C', 'Rare': 'R', 'Double rare': 'SR',
  'Ultra Rare': 'UR', 'Illustration rare': 'UR',
  'Special illustration rare': 'SEC', 'Hyper rare': 'SEC', 'Black White Rare': 'SEC', 'Mega Hyper Rare': 'SEC'
};
const PKM_RARITY_CODE = {
  'Common': 'C', 'Uncommon': 'U', 'Rare': 'R', 'Double rare': 'RR', 'Ultra Rare': 'UR', 'Illustration rare': 'IR',
  'Special illustration rare': 'SIR', 'Hyper rare': 'HR', 'Black White Rare': 'BWR', 'Mega Hyper Rare': 'MUR'
};

const clean = (s, n) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function buildPokemon(def, needArt) {
  const cards = require(path.join(TCGDEX, 'cards', def.serie, def.set + '.json'));
  const out = [];
  for (const c of cards) {
    const tier = PKM_TIER[c.rarity];
    if (!tier) continue;
    const no = c.id.slice(def.set.length + 1);
    const dex = c.dexId && c.dexId[0];
    const hasArt = dex && artSource(dex);
    if (hasArt) needArt.add(dex);
    const card = {
      id: def.id + '-' + no,
      no,
      name: c.name.en,
      rarity: c.rarity,
      code: PKM_RARITY_CODE[c.rarity],
      tier,
      img: `https://assets.tcgdex.net/en/${def.serie}/${def.set}/${no}/high.webp`,
      cat: c.category,
      illus: c.illustrator || ''
    };
    if (c.category === 'Pokemon') {
      Object.assign(card, {
        hp: c.hp || 0,
        type: (c.types || ['Colorless'])[0],
        stage: c.stage || 'Basic',
        dex: hasArt ? dex : null,
        ab: c.abilities && c.abilities[0] ? clean(c.abilities[0].name.en, 30) : '',
        atk: (c.attacks || []).slice(0, 2).map((a) => ({ n: clean(a.name.en, 26), c: (a.cost || []).length, d: a.damage ? String(a.damage) : '' })),
        weak: c.weaknesses && c.weaknesses[0] ? c.weaknesses[0].type : '',
        ret: c.retreat || 0
      });
    } else {
      Object.assign(card, {
        type: c.category === 'Energy' ? (c.types || ['Colorless'])[0] : 'Trainer',
        sub: c.trainerType || (c.category === 'Energy' ? 'Energy' : ''),
        fx: clean(c.effect && c.effect.en, 150)
      });
    }
    out.push(card);
  }
  return out;
}

async function renderArt(dexes) {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const keep = new Set();
  for (const dex of dexes) {
    const file = path.join(ART_DIR, dex + '.webp');
    keep.add(dex + '.webp');
    if (fs.existsSync(file)) continue;
    const src = artSource(dex);
    let img = sharp(src.file, src.density ? { density: src.density } : {});
    if (!src.density) img = img.trim(); // official artwork has transparent padding; dream-world SVGs are tight
    await img
      .resize(260, 260, { fit: 'inside' })
      .webp({ quality: 74, alphaQuality: 80 })
      .toFile(file);
  }
  for (const f of fs.readdirSync(ART_DIR)) if (!keep.has(f)) fs.unlinkSync(path.join(ART_DIR, f));
}

async function main() {
  const needArt = new Set();
  const series = [];
  const allDex = new Set();
  for (const def of POKEMON_SETS) {
    for (const c of require(path.join(TCGDEX, 'cards', def.serie, def.set + '.json'))) if (c.dexId && c.dexId[0]) allDex.add(c.dexId[0]);
  }
  await fetchOfficial([...allDex].sort((a, b) => a - b));
  for (const def of POKEMON_SETS) {
    series.push({ id: def.id, game: 'pokemon', name: def.name, short: def.short, hue: def.hue, tag: def.tag, coverDex: def.cover, cards: buildPokemon(def, needArt) });
    needArt.add(def.cover);
  }
  await renderArt([...needArt].sort((a, b) => a - b));
  const body = '/* Generated by scripts/build-cards.js from real TCG data. Do not edit by hand. */\n' +
    '(function (root) {\n  var cards = ' + JSON.stringify({ series }) + ';\n' +
    '  root.PN = root.PN || {};\n  root.PN.cardsData = cards;\n' +
    "  if (typeof module !== 'undefined' && module.exports) module.exports = cards;\n" +
    "})(typeof globalThis !== 'undefined' ? globalThis : this);\n";
  fs.writeFileSync(OUT, body);
  for (const s of series) {
    const t = {};
    s.cards.forEach((c) => { t[c.tier] = (t[c.tier] || 0) + 1; });
    console.log(s.id.padEnd(5), s.name.padEnd(28), String(s.cards.length).padStart(4), JSON.stringify(t));
  }
  console.log('art files:', needArt.size, ' cards.js:', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
}

main().catch((e) => { console.error(e); process.exit(1); });

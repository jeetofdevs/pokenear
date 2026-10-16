'use strict';
/* Builds the Pokenear brand files in assets/brand/:
   - pokenear-icon.svg/.png   the "N orb" mark (collector ball + NEAR-style N)
   - pokenear-logo.svg/.png   arched wordmark with the orb as the O, plus tagline ribbon
   - x-profile.png            400x400 profile picture
   Text is converted to vector outlines (opentype.js), so the SVGs need no fonts.
   Run: npm run build:brand   (x-header.png is rendered separately, see scripts/render-x-header.js) */
const fs = require('node:fs');
const path = require('node:path');
const opentype = require('opentype.js');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets/brand');
const font = (p) => opentype.parse(fs.readFileSync(path.join(ROOT, 'node_modules', p)).buffer);
const DISPLAY = font('@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff');
const BOLD = font('@fontsource/figtree/files/figtree-latin-900-normal.woff');

const C = {
  navy: '#141c52', blue: '#2b5fd9', sky: '#5aa7ff',
  gold1: '#fff27a', gold2: '#ffcf1f', gold3: '#f2a20c',
  mint1: '#5cffc4', mint2: '#00ec97', mint3: '#00a6a6',
  ink: '#000000', white: '#ffffff', near: '#00ec97'
};

const r = (n) => Math.round(n * 100) / 100;

/* ---------- the orb ---------- */
// NEAR symbol (official mark, 90x90 viewBox), scaled into a box of size s at (x, y).
const NEAR_MARK = 'M72.2,4.6L53.4,32.5c-1.3,1.9,1.2,4.2,3,2.6L74.9,19c0.5-0.4,1.2-0.1,1.2,0.6v50.3c0,0.7-0.9,1-1.3,0.5l-56-67C17,1.2,14.4,0,11.5,0h-2C4.3,0,0,4.3,0,9.6v70.8C0,85.7,4.3,90,9.6,90c3.3,0,6.4-1.7,8.2-4.6l18.8-27.9c1.3-1.9-1.2-4.2-3-2.6l-18.5,16c-0.5,0.4-1.2,0.1-1.2-0.6V20.1c0-0.7,0.9-1,1.3-0.5l56,67c1.8,2.2,4.5,3.4,7.3,3.4h2c5.3,0,9.6-4.3,9.6-9.6V9.6c0-5.3-4.3-9.6-9.6-9.6C77.1,0,74,1.7,72.2,4.6z';
function nGlyph(x, y, s, fill) {
  return `<path fill="${fill}" transform="translate(${r(x)},${r(y)}) scale(${r(s / 90 * 1000) / 1000})" d="${NEAR_MARK}"/>`;
}

function orb(cx, cy, rad, id) {
  const band = rad * 0.16;
  const btn = rad * 0.42;
  return `
  <defs>
    <linearGradient id="${id}-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3f4f"/><stop offset="0.55" stop-color="#15171f"/><stop offset="1" stop-color="#000000"/></linearGradient>
    <linearGradient id="${id}-bot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d6dcf0"/></linearGradient>
    <radialGradient id="${id}-shine" cx="0.32" cy="0.22" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}-clip"><circle cx="${cx}" cy="${cy}" r="${rad}"/></clipPath>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${r(rad + rad * 0.13)}" fill="${C.navy}"/>
  <g clip-path="url(#${id}-clip)">
    <rect x="${cx - rad}" y="${cy - rad}" width="${rad * 2}" height="${rad}" fill="url(#${id}-top)"/>
    <rect x="${cx - rad}" y="${cy}" width="${rad * 2}" height="${rad}" fill="url(#${id}-bot)"/>
    <rect x="${cx - rad}" y="${r(cy - band / 2)}" width="${rad * 2}" height="${r(band)}" fill="${C.ink}"/>
    <circle cx="${cx}" cy="${cy}" r="${rad}" fill="url(#${id}-shine)"/>
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r(btn + rad * 0.1)}" fill="${C.ink}"/>
  <circle cx="${cx}" cy="${cy}" r="${r(btn)}" fill="${C.near}"/>
  ${nGlyph(cx - btn * 0.56, cy - btn * 0.56, btn * 1.12, C.ink)}`;
}

/* ---------- arched wordmark ---------- */
// Letters grow toward the middle and hang from a straight top line, so the bottom edge
// bulges like a classic trading-card logo.
function wordmark(text, opts) {
  const n = text.length;
  const base = opts.size;
  let x = 0;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const size = base * (1 + opts.bulge * (1 - t * t));
    const ch = text[i];
    const top = 0;
    const baseline = top + size * 0.72;
    if (ch === 'O' && opts.orbForO) {
      const rad = size * 0.33;
      const gap = opts.orbGap || 0;
      parts.push({ orb: true, x: x + gap + rad * 1.05, cy: baseline - size * 0.34, rad });
      x += rad * 2.1 + gap * 2 + opts.track;
      continue;
    }
    const glyph = DISPLAY.charToGlyph(ch);
    const adv = (glyph.advanceWidth / DISPLAY.unitsPerEm) * size;
    const p = glyph.getPath(x, baseline, size).toPathData(2);
    parts.push({ d: p, x, adv });
    x += adv + opts.track;
  }
  return { parts, width: x - opts.track, height: base * (1 + opts.bulge) * 0.74 };
}

function wordmarkSVG(wm, dx, dy, id) {
  const d = wm.parts.filter((p) => p.d).map((p) => p.d).join(' ');
  const T = `translate(${r(dx)},${r(dy)})`;
  // The orb gets the same navy + blue outline as the letters.
  const orbs = wm.parts.filter((p) => p.orb).map((p, i) => `<g transform="${T}">` +
    `<circle cx="${r(p.x)}" cy="${r(p.cy + wm.stroke * 0.55)}" r="${r(p.rad * 1.13 + wm.stroke * 1.1)}" fill="${C.navy}"/>` +
    `<circle cx="${r(p.x)}" cy="${r(p.cy)}" r="${r(p.rad * 1.13 + wm.stroke * 1.1)}" fill="${C.navy}"/>` +
    `<circle cx="${r(p.x)}" cy="${r(p.cy)}" r="${r(p.rad * 1.13 + wm.stroke * 0.58)}" fill="${C.blue}"/>` +
    orb(r(p.x), r(p.cy), r(p.rad), id + '-o' + i) + '</g>').join('');
  return `
  <defs>
    <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.gold1}"/><stop offset="0.55" stop-color="${C.gold2}"/><stop offset="1" stop-color="${C.gold3}"/></linearGradient>
  </defs>
  <g transform="${T}" stroke-linejoin="round" stroke-linecap="round">
    <path d="${d}" fill="${C.navy}" stroke="${C.navy}" stroke-width="${r(wm.stroke * 2.2)}" transform="translate(0,${r(wm.stroke * 0.55)})"/>
    <path d="${d}" fill="${C.navy}" stroke="${C.navy}" stroke-width="${r(wm.stroke * 2.2)}"/>
    <path d="${d}" fill="${C.blue}" stroke="${C.blue}" stroke-width="${r(wm.stroke * 1.15)}"/>
    <path d="${d}" fill="url(#${id}-fill)"/>
  </g>${orbs}`;
}

function textPath(fontObj, str, x, y, size, letterSpacing) {
  let cx = x;
  const out = [];
  for (const ch of str) {
    const g = fontObj.charToGlyph(ch);
    out.push(g.getPath(cx, y, size).toPathData(2));
    cx += (g.advanceWidth / fontObj.unitsPerEm) * size + letterSpacing;
  }
  return { d: out.join(' '), width: cx - x - letterSpacing };
}

function ribbon(cx, y, label, size, id) {
  const t = textPath(BOLD, label, 0, 0, size, size * 0.18);
  const padX = size * 1.1;
  const h = size * 1.9;
  const w = t.width + padX * 2;
  const x0 = cx - w / 2;
  const tail = h * 0.55;
  return `
  <defs><linearGradient id="${id}-rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a6ff0"/><stop offset="1" stop-color="${C.navy}"/></linearGradient></defs>
  <path d="M${r(x0 - tail)},${r(y + h * 0.2)} L${r(x0)},${r(y + h * 0.2)} L${r(x0)},${r(y + h * 1.05)} L${r(x0 - tail)},${r(y + h * 1.05)} L${r(x0 - tail * 0.55)},${r(y + h * 0.62)} Z" fill="#0d1440"/>
  <path d="M${r(x0 + w + tail)},${r(y + h * 0.2)} L${r(x0 + w)},${r(y + h * 0.2)} L${r(x0 + w)},${r(y + h * 1.05)} L${r(x0 + w + tail)},${r(y + h * 1.05)} L${r(x0 + w + tail * 0.55)},${r(y + h * 0.62)} Z" fill="#0d1440"/>
  <rect x="${r(x0)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(h * 0.18)}" fill="url(#${id}-rb)" stroke="${C.navy}" stroke-width="${r(size * 0.22)}"/>
  <path d="${t.d}" transform="translate(${r(cx - t.width / 2)},${r(y + h * 0.5 + size * 0.36)})" fill="#ffffff"/>`;
}

/* ---------- compose ---------- */
function iconSVG(size, background) {
  const bg = background
    ? `<defs><radialGradient id="bg" cx="0.5" cy="0.38" r="0.75"><stop offset="0" stop-color="#2a3a9a"/><stop offset="1" stop-color="#0a0e2e"/></radialGradient></defs>
       <rect width="${size}" height="${size}" fill="url(#bg)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${orb(size / 2, size / 2, size * (background ? 0.34 : 0.43), 'icon')}</svg>`;
}

function logoSVG() {
  const wm = wordmark('POKENEAR', { size: 220, bulge: 0.2, track: -6, orbForO: true, orbGap: 16 });
  wm.stroke = 26;
  const pad = 70;
  const W = Math.ceil(wm.width + pad * 2);
  const ribbonY = pad + wm.height + 26;
  const H = Math.ceil(ribbonY + 34 * 1.9 + pad * 0.7);
  const body = wordmarkSVG(wm, pad, pad, 'wm') + ribbon(W / 2, ribbonY, 'TRADING CARD GACHA', 34, 'tg');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`, W, H };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const icon = iconSVG(1024, false);
  fs.writeFileSync(path.join(OUT, 'pokenear-icon.svg'), icon);
  await sharp(Buffer.from(icon)).png().toFile(path.join(OUT, 'pokenear-icon.png'));

  const logo = logoSVG();
  fs.writeFileSync(path.join(OUT, 'pokenear-logo.svg'), logo.svg);
  await sharp(Buffer.from(logo.svg), { density: 144 }).png().toFile(path.join(OUT, 'pokenear-logo.png'));

  await sharp(Buffer.from(iconSVG(400, true))).png().toFile(path.join(OUT, 'x-profile.png'));
  for (const f of fs.readdirSync(OUT)) console.log(f.padEnd(22), (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { logoSVG, iconSVG };

'use strict';
/* Live USD price of the payment coin (SOL or NEAR) for pack quotes. Six public sources
   (Binance, CoinGecko, Kraken, Coinbase, OKX, Bybit) are asked in parallel and the median of the
   valid answers is used, so one bad or blocked source cannot move the price.
   Cached for CACHE_MS; if every source fails, the last good price is used for up to STALE_MS.
   PRICE_URL (or NEAR_PRICE_URL) replaces the sources with one URL returning {"usd": <number>} (tests). */

const CACHE_MS = 30 * 1000;
const STALE_MS = 10 * 60 * 1000;
const RANGE = { SOL: [1, 100000], NEAR: [0.05, 1000] };
const IDS = { SOL: { gecko: 'solana', kraken: 'SOLUSD' }, NEAR: { gecko: 'near', kraken: 'NEARUSD' } };

function sourcesFor(asset) {
  const custom = process.env.PRICE_URL || process.env.NEAR_PRICE_URL;
  if (custom) return [{ name: 'custom', url: custom, parse: (j) => Number(j.usd) }];
  const id = IDS[asset];
  return [
    { name: 'binance', url: `https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDT`, parse: (j) => Number(j.price) },
    { name: 'coingecko', url: `https://api.coingecko.com/api/v3/simple/price?ids=${id.gecko}&vs_currencies=usd`, parse: (j) => Number(j[id.gecko] && j[id.gecko].usd) },
    { name: 'kraken', url: `https://api.kraken.com/0/public/Ticker?pair=${id.kraken}`, parse: (j) => { const r = j.result && Object.values(j.result)[0]; return Number(r && r.c && r.c[0]); } },
    { name: 'coinbase', url: `https://api.coinbase.com/v2/prices/${asset}-USD/spot`, parse: (j) => Number(j.data && j.data.amount) },
    { name: 'okx', url: `https://www.okx.com/api/v5/market/ticker?instId=${asset}-USDT`, parse: (j) => Number(j.data && j.data[0] && j.data[0].last) },
    { name: 'bybit', url: `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${asset}USDT`, parse: (j) => Number(j.result && j.result.list && j.result.list[0] && j.result.list[0].lastPrice) }
  ];
}

const cache = {}; // asset -> { usd, at, sources }
const inflight = {};

async function ask(src, asset) {
  const res = await fetch(src.url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(src.name + ' HTTP ' + res.status);
  const usd = src.parse(await res.json());
  const [lo, hi] = RANGE[asset] || [0, Infinity];
  if (!Number.isFinite(usd) || usd < lo || usd > hi) throw new Error(src.name + ' bad price');
  return { name: src.name, usd };
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// -> { usd, at, sources, stale } or null when no price is known.
async function priceUsd(asset = 'NEAR') {
  const c = cache[asset];
  if (c && Date.now() - c.at < CACHE_MS) return c;
  if (!inflight[asset]) {
    inflight[asset] = Promise.allSettled(sourcesFor(asset).map((s) => ask(s, asset))).then((results) => {
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (ok.length) cache[asset] = { usd: median(ok.map((x) => x.usd)), at: Date.now(), sources: ok.map((x) => x.name), stale: false };
      else console.warn(`[price] no ${asset} price source answered:`, results.map((r) => r.reason && r.reason.message).join('; '));
    }).finally(() => { delete inflight[asset]; });
  }
  await inflight[asset];
  const now = cache[asset];
  if (now && Date.now() - now.at < CACHE_MS) return now;
  if (now && Date.now() - now.at < STALE_MS) return { ...now, stale: true };
  return null;
}

const nearUsd = () => priceUsd('NEAR');
function reset() { for (const k of Object.keys(cache)) delete cache[k]; }

module.exports = { priceUsd, nearUsd, median, reset, CACHE_MS };

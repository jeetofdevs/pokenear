'use strict';
/* Live NEAR/USD price for pack quotes. Six public sources (Binance, CoinGecko, Kraken, Coinbase, OKX, Bybit) are asked in parallel and the
   median of the valid answers is used, so one bad or blocked source cannot move the price.
   Cached for CACHE_MS; if every source fails, the last good price is used for up to STALE_MS.
   NEAR_PRICE_URL (env) replaces the sources with one URL returning {"usd": <number>} (tests). */

const CACHE_MS = 30 * 1000;
const STALE_MS = 10 * 60 * 1000;
const MIN_USD = 0.05;
const MAX_USD = 1000;

const SOURCES = [
  { name: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', parse: (j) => Number(j.price) },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', parse: (j) => Number(j.near && j.near.usd) },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=NEARUSD', parse: (j) => { const r = j.result && Object.values(j.result)[0]; return Number(r && r.c && r.c[0]); } },
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/NEAR-USD/spot', parse: (j) => Number(j.data && j.data.amount) },
  { name: 'okx', url: 'https://www.okx.com/api/v5/market/ticker?instId=NEAR-USDT', parse: (j) => Number(j.data && j.data[0] && j.data[0].last) },
  { name: 'bybit', url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=NEARUSDT', parse: (j) => Number(j.result && j.result.list && j.result.list[0] && j.result.list[0].lastPrice) }
];

let cache = null; // { usd, at, sources }
let inflight = null;

function sources() {
  if (process.env.NEAR_PRICE_URL) return [{ name: 'custom', url: process.env.NEAR_PRICE_URL, parse: (j) => Number(j.usd) }];
  return SOURCES;
}

async function ask(src) {
  const res = await fetch(src.url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(src.name + ' HTTP ' + res.status);
  const usd = src.parse(await res.json());
  if (!Number.isFinite(usd) || usd < MIN_USD || usd > MAX_USD) throw new Error(src.name + ' bad price');
  return { name: src.name, usd };
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// -> { usd, at, sources, stale } or null when no price is known.
async function nearUsd() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (!inflight) {
    inflight = Promise.allSettled(sources().map(ask)).then((results) => {
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (ok.length) cache = { usd: median(ok.map((x) => x.usd)), at: Date.now(), sources: ok.map((x) => x.name), stale: false };
      else console.warn('[price] no NEAR price source answered:', results.map((r) => r.reason && r.reason.message).join('; '));
    }).finally(() => { inflight = null; });
  }
  await inflight;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (cache && Date.now() - cache.at < STALE_MS) return { ...cache, stale: true };
  return null;
}

function reset() { cache = null; }

module.exports = { nearUsd, median, reset, CACHE_MS };

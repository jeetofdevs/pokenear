'use strict';
// Live NEAR/USD price feed: median of sources, rejects nonsense, keeps the last good price briefly.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const price = require('../server/price.js');

test('median', () => {
  assert.equal(price.median([3]), 3);
  assert.equal(price.median([5, 1, 3]), 3);
  assert.equal(price.median([1, 2, 3, 10]), 2.5);
});

test('nearUsd reads the feed, caches it, and ignores bad answers', async () => {
  let answer = { usd: 2.5 };
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    if (!answer) { res.writeHead(503); return res.end('down'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.NEAR_PRICE_URL = `http://127.0.0.1:${srv.address().port}/`;
  try {
    price.reset();
    const p = await price.nearUsd();
    assert.equal(p.usd, 2.5);
    assert.deepEqual(p.sources, ['custom']);
    await price.nearUsd();
    assert.equal(calls, 1); // cached
    price.reset();
    answer = { usd: 1e9 }; // nonsense is rejected
    assert.equal(await price.nearUsd(), null);
    price.reset();
    answer = null; // feed down and nothing cached
    assert.equal(await price.nearUsd(), null);
  } finally {
    delete process.env.NEAR_PRICE_URL;
    srv.close();
  }
});

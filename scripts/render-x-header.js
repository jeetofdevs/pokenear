'use strict';
/* Renders X images from HTML sources in assets/brand/:
     node scripts/render-x-header.js          -> x-header.png (1500x500 profile header)
     node scripts/render-x-header.js post     -> x-post.png   (1600x900 post image)
   Needs Playwright with a Chromium build: npm i -D playwright && npx playwright install chromium */
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const globalRoot = require('node:child_process').execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

const ROOT = path.resolve(__dirname, '..');
const JOBS = {
  header: { file: 'x-header', width: 1500, height: 500, el: '#hdr' },
  post: { file: 'x-post', width: 1600, height: 900, el: '#post' }
};
const job = JOBS[process.argv[2] || 'header'];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}/assets/brand/${job.file}.html`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.locator(job.el).screenshot({ path: path.join(ROOT, `assets/brand/${job.file}.png`), animations: 'disabled' });
  await browser.close();
  server.close();
  console.log(`wrote assets/brand/${job.file}.png`);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Minimal in-memory stand-in for the Upstash Redis REST API (the commands server/kv.js uses).
const http = require('node:http');

function createRedisMock(token) {
  const hashes = new Map();
  const strings = new Map(); // key -> { value, until }
  const hash = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  function run(args) {
    const [name, ...a] = args.map(String);
    switch (name.toUpperCase()) {
      case 'HGETALL': return [...hash(a[0])].flat();
      case 'HMGET': return a.slice(1).map((f) => (hash(a[0]).has(f) ? hash(a[0]).get(f) : null));
      case 'HSET': { let n = 0; for (let i = 1; i < a.length; i += 2) { if (!hash(a[0]).has(a[i])) n++; hash(a[0]).set(a[i], a[i + 1]); } return n; }
      case 'HDEL': return a.slice(1).filter((f) => hash(a[0]).delete(f)).length;
      case 'SET': {
        const cur = strings.get(a[0]);
        const live = cur && cur.until > Date.now();
        if (a.includes('NX') && live) return null;
        const px = a.indexOf('PX');
        strings.set(a[0], { value: a[1], until: px > 0 ? Date.now() + Number(a[px + 1]) : Infinity });
        return 'OK';
      }
      case 'EVAL': { // only the compare-and-delete unlock script
        const cur = strings.get(a[2]);
        if (cur && cur.value === a[3]) { strings.delete(a[2]); return 1; }
        return 0;
      }
      default: throw new Error('unsupported ' + name);
    }
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== 'Bearer ' + token) return reply(401, { error: 'Unauthorized' });
      try {
        const cmds = JSON.parse(body);
        if (req.url === '/pipeline') return reply(200, cmds.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } }));
        return reply(200, { result: run(cmds) });
      } catch (e) { return reply(400, { error: e.message }); }
    });
  });
  return { server, hashes };
}

module.exports = { createRedisMock };

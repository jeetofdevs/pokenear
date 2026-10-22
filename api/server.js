'use strict';
// Vercel serverless entry: every /api/* request is rewritten here (vercel.json) and handled by the
// same server code as `npm start`, with game data in Upstash Redis (server/kv.js).
const srv = require('../server/server.js');

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('__p');
  if (p !== null) {
    url.searchParams.delete('__p');
    req.url = '/api/' + p + url.search;
  }
  return srv.handle(req, res);
};

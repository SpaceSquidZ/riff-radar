// scripts/local-server.mjs
//
// Minimal local HTTP server wrapping api/chat.js's handler directly, for
// running replay.mjs against localhost without the Vercel CLI (not installed
// in every environment this runs in). Node's native http.ServerResponse is
// missing the two Vercel-runtime conveniences the handler calls
// (`res.status(code).json(obj)`), so they're polyfilled below; everything
// else (`res.writeHead`, `res.write`, `res.end`) is native and needs nothing.
//
// This is a real HTTP server — genuine TCP, genuine chunked transfer — not an
// in-process function call, so replay.mjs's ttft_ms/duration_ms measurements
// reflect real streaming behavior. The only thing it does NOT reproduce is
// Vercel's own network hop and cold-start behavior, which is consistent
// across every arm of an A/B test and so should not bias a comparison
// between them.
//
// Usage:
//   GROOVE_THINKING_ARM=A node scripts/local-server.mjs [port]
//
// Loads .env and .env.local itself (see loadEnv.mjs) -- no manual shell
// sourcing required, and no dependency on whatever the parent process
// happened to have exported. This matters because api/chat.js imports
// src/supabaseClient.js, which reads its env vars into top-level consts AT
// MODULE-EVALUATION TIME, once, forever -- if that import runs before env
// vars are loaded, supabaseAdmin is permanently null for the process's
// whole life, no matter what gets set into process.env afterward. ESM
// static imports are hoisted above all other code regardless of where they
// appear in the file, so loadRepoEnv() has to run before chat.js is
// imported at all, via a dynamic import() (dynamic imports are NOT
// hoisted -- they execute in program order).
//
// GROOVE_THINKING_ARM is read fresh by api/chat.js on every request (not
// cached at import time), so it can also be changed by restarting this
// server between batches without touching any code.

import http from 'node:http';
import { loadRepoEnv } from './loadEnv.mjs';

loadRepoEnv();
const { default: handler } = await import('../api/chat.js');

const port = Number(process.argv[2]) || 8787;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function polyfillResponse(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function json(obj) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  polyfillResponse(res);

  if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  try {
    const raw = await readBody(req);
    req.body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error('[local-server] handler threw:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ type: 'error', message: 'local-server: handler threw' }));
    }
  }
});

server.listen(port, () => {
  console.log(
    `[local-server] listening on http://localhost:${port} (GROOVE_THINKING_ARM=${
      process.env.GROOVE_THINKING_ARM || '(unset, arm A default)'
    })`
  );
});

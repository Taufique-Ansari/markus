/**
 * Stand-in for "the local Markus app behind the user's tunnel" (T10 E2E).
 *
 * The point of the harness is that the tunnel — NOT our server — carries the
 * traffic. So this process plays the part of `markus start` on the user's
 * machine: it answers the Hub's ownership probe and serves the app root.
 *
 * It reads `verifyPath`/`verifyToken` from a JSON state file on every request,
 * because the Hub only mints them *after* the tunnel is already up.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env['STUB_PORT'] ?? 18056);
const STATE = process.env['STUB_STATE'] ?? '/tmp/markus-e2e-verify.json';

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const verify = loadState();

  // ① The ownership probe path the Hub will hit through the public tunnel.
  //    Contract §7.1: the probe response must be JSON `{"token": "…"}` — the
  //    Hub parses it and compares against the token it minted at registration.
  if (verify.verifyPath && url.pathname === verify.verifyPath) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: String(verify.verifyToken ?? '') }));
    return;
  }

  // ② The "my Markus" root, so we can prove the data path end to end.
  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('MARKUS-LOCAL-APP-OK');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT} state=${STATE}`);
});

// itch-style wrapper for the engine harness. It is a page on http://localhost:<port>/ that embeds
// the harness from another site (http://127.0.0.1:<harness port>/) in an iframe with itch.io's
// exact iframe attributes. It mirrors the game's scripts/itch-sim (itch observed 2026-11-02),
// minus the nested-path file server, because Vite serves the harness.
//
//   node e2e/wrapper.mjs --port 4178 --target http://127.0.0.1:4177/
//
// Query params: ?w=960&h=540 sets the iframe size (default 960x540, the recommended itch size).
import { createServer } from 'node:http';

const ITCH_IFRAME_ALLOW =
  'autoplay; fullscreen *; geolocation; microphone; camera; midi; monetization; ' +
  'xr-spatial-tracking; gamepad; gyroscope; accelerometer; xr; cross-origin-isolated; web-share';

const argv = process.argv.slice(2);
/** @param {string} k */
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(arg('--port') ?? 4178);
const target = arg('--target') ?? 'http://127.0.0.1:4177/';

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>itch-style wrapper</title>
    <style>
      body { margin: 0; background: #2b2b2b; }
      main { padding: 24px; display: flex; justify-content: center; }
      #frame { background: #000; }
      #frame iframe { border: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <main><div id="frame"></div></main>
    <script>
      const q = new URLSearchParams(location.search);
      const frame = document.getElementById('frame');
      frame.style.width = (Number(q.get('w')) || 960) + 'px';
      frame.style.height = (Number(q.get('h')) || 540) + 'px';
      const iframe = document.createElement('iframe');
      iframe.id = 'game_drop';
      // The same attributes itch.io sets on the game iframe.
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('allowtransparency', 'true');
      iframe.setAttribute('webkitallowfullscreen', 'true');
      iframe.setAttribute('mozallowfullscreen', 'true');
      iframe.setAttribute('msallowfullscreen', 'true');
      iframe.setAttribute('allow', ${JSON.stringify(ITCH_IFRAME_ALLOW)});
      iframe.src = ${JSON.stringify(target)};
      frame.append(iframe);
      iframe.addEventListener('load', () => iframe.focus());
    </script>
  </body>
</html>
`;

createServer((req, res) => {
  const path = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
  if (path !== '/' && path !== '/index.html') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // itch.io sends this on game pages.
    'content-security-policy': "frame-ancestors 'self'",
  });
  res.end(page);
}).listen(port, 'localhost', () => {
  console.log(`[harness-wrapper] http://localhost:${port}/ embeds ${target}`);
});

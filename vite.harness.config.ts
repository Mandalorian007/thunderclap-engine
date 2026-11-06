import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const demosDir = fileURLToPath(new URL('./demos', import.meta.url));

/**
 * Serves `demos/<name>/` (E-021) from the harness server at `/demos/<name>/`, so one server and
 * one origin cover the harness pages and the demos: the request is rewritten to Vite's `/@fs/`
 * form, which serves and transforms files outside `root` (the repo is the allowed workspace).
 */
function serveDemos(): Plugin {
  return {
    name: 'thunderclap:serve-demos',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/demos/')) {
          const [path, query] = req.url.split('?');
          const file = path!.endsWith('/') ? `${path}index.html` : path!;
          req.url = `/@fs${demosDir}${file.slice('/demos'.length)}${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
  };
}

// Serves the noun-free engine harness page (harness/) to the engine e2e specs (e2e/).
export default defineConfig({
  root: 'harness',
  clearScreen: false,
  plugins: [serveDemos()],
});

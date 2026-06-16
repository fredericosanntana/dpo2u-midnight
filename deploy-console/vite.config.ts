import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Serve the compiled Compact artifacts (../build/<Contract>/{keys,zkir,...}) at /zk/<Contract>/...
// so FetchZkConfigProvider can fetch prover/verifier keys + zkir over HTTP in the browser.
function serveZkArtifacts() {
  const buildDir = path.resolve(__dirname, '..', 'build');
  return {
    name: 'serve-zk-artifacts',
    configureServer(server: any) {
      server.middlewares.use('/zk', (req: any, res: any, next: any) => {
        try {
          const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
          const file = path.join(buildDir, rel);
          if (!file.startsWith(buildDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
          res.setHeader('content-type', 'application/octet-stream');
          fs.createReadStream(file).pipe(res);
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), serveZkArtifacts()],
  define: { global: 'globalThis' },
  optimizeDeps: {
    // Midnight WASM packages must not be pre-bundled (esbuild can't handle their wasm).
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/midnight-js-contracts',
    ],
    // Force pre-bundle of CJS transitive deps so dev-mode ESM interop works
    // (without this, dev errors: "object-inspect ... does not provide an export named 'default'").
    include: ['buffer', 'object-inspect'],
    esbuildOptions: { define: { global: 'globalThis' } },
  },
  server: { port: 5173, host: '127.0.0.1', fs: { allow: ['..'] } },
  build: { target: 'esnext' },
});

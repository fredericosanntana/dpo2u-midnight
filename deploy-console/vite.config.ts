import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Serve the compiled Compact artifacts (../build/<Contract>/{keys,zkir,...}) at /zk/<Contract>/...
// so FetchZkConfigProvider can fetch prover/verifier keys + zkir over HTTP in the browser.
function serveZkArtifacts() {
  const buildDir = path.resolve(__dirname, '..', 'build');
  const mw = (req: any, res: any, next: any) => {
    try {
      const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
      const file = path.join(buildDir, rel);
      if (!file.startsWith(buildDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
      res.setHeader('content-type', 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } catch { next(); }
  };
  return {
    name: 'serve-zk-artifacts',
    configureServer(server: any) { server.middlewares.use('/zk', mw); },        // dev
    configurePreviewServer(server: any) { server.middlewares.use('/zk', mw); }, // preview (built)
    closeBundle() {
      // make the built dist self-contained: copy ../build → dist/zk so any static server works.
      const dest = path.resolve(__dirname, 'dist', 'zk');
      if (fs.existsSync(buildDir)) { fs.rmSync(dest, { recursive: true, force: true }); fs.cpSync(buildDir, dest, { recursive: true }); }
    },
  };
}

const LEDGER_BROWSER_GLUE = path.resolve(__dirname, 'node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm.js');
const OCRT_BROWSER_GLUE = path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm.js');

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), serveZkArtifacts()],
  define: { global: 'globalThis' },
  resolve: {
    // ledger-v8 ships a browser glue (midnight_ledger_wasm.js) AND a node glue (…_fs.js); under
    // mixed export conditions the bundle ends up with 3 copies of the WASM classes, so a
    // ContractMaintenanceAuthority built by one fails `instanceof` in another → deploy throws
    // "expected instance of ContractMaintenanceAuthority". Force every resolution to the single
    // browser glue.
    dedupe: ['@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', '@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/zswap'],
    alias: [
      { find: /[\\/]midnight_ledger_wasm_fs\.js$/, replacement: LEDGER_BROWSER_GLUE },
      { find: /^@midnight-ntwrk\/ledger-v8$/, replacement: LEDGER_BROWSER_GLUE },
      { find: /[\\/]midnight_onchain_runtime_wasm_fs\.js$/, replacement: OCRT_BROWSER_GLUE },
      { find: /^@midnight-ntwrk\/onchain-runtime-v3$/, replacement: OCRT_BROWSER_GLUE },
    ],
    conditions: ['browser', 'import', 'module', 'default'],
  },
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
  server: {
    port: 5173, host: '127.0.0.1', fs: { allow: ['..'] },
    // Browser → same-origin /proof → local proof-server. Dodges CORS entirely and means only ONE
    // port (5173) needs to be reachable over Tailscale (the proof-server stays loopback-only).
    proxy: {
      '/proof': { target: 'http://127.0.0.1:6300', changeOrigin: true, rewrite: (p) => p.replace(/^\/proof/, '') },
    },
  },
  // unminified + sourcemaps so runtime errors show real function/module names (debugging the seam)
  build: { target: 'esnext', minify: false, sourcemap: true },
});

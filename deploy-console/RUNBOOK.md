# Deploy console — deploy the 9 contracts to preprod via Lace

The headless WalletFacade full-sync OOM-kills this 31GB box (preprod shielded+dust history is huge).
Lace syncs **inside the extension** (persistent), so this browser console just asks Lace to balance + submit.

**What is verified (headless, by the agent):** the console builds (`vite build` ✓), serves, executes
(WASM inits, no crash), serves the ZK artifacts at `/zk/*`, and the connect path runs.
**What only you can validate (needs a real Lace):** the live `balanceUnsealedTransaction` / `submitTransaction`
handshake. The console logs every connector call + payload, so any seam issue is visible in the on-screen log.

---

## 0. Where to run it
The console must run **where your browser + Lace live** (your laptop). It needs:
- the `deploy-console/` folder **and** the `build/` folder (the compiled ZK artifacts) next to it,
- a **local proof-server** reachable at `http://127.0.0.1:6300`,
- network access to the **public preprod indexer** (automatic, via Lace's config).

Copy `deploy-console/` + `build/` to your laptop, or port-forward `5173` + `6300` from this host
(e.g. over Tailscale) to your laptop browser.

## 1. Lace (one-time)
1. Install the **Midnight Lace** wallet extension (Chrome/Brave/Edge).
2. **Import the funded wallet** — Lace → restore from seed phrase, paste the 24-word mnemonic from
   `../.midnight-mnemonic`. This is the wallet that already holds **6,000,000,000 tNIGHT** on preprod
   (address `mn_addr_preprod1jelp33c…px5g`).
3. Lace settings → **Network: Preprod**. Let Lace finish its initial sync (background; first time can be slow,
   but it persists — you only pay it once).
4. Lace settings → set the **proof server** to your local one (`http://localhost:6300`) if Lace asks.
5. Tokens tab → **Generate tDUST** (converts some tNIGHT → tDUST to pay fees), confirm.

## 2. Host side (where the repo is)
```bash
# proof-server up (port 6300) — generates the ZK proofs
docker ps | grep proof-server || npm run start-proof-server   # from repo root

# contracts compiled (regenerate if build/ was cleared)
npm run compile           # from repo root → build/<Contract>/

# start the console
cd deploy-console && npm install && npm run dev   # http://127.0.0.1:5173
```

## 3. Deploy
1. Open `http://127.0.0.1:5173`.
2. **Connect Lace** → approve. The pills should show your address, `preprod`, and the tNIGHT balance.
   - If it says *Lace not found* → extension not installed/unlocked.
   - If the network pill is **not** `preprod` → switch the network in Lace.
3. **Deploy all 9 ▸** — each contract pops a Lace approval; approve them one at a time. The table fills
   with the on-chain address + block + tx per contract.
4. **Export JSON** → `deployment-preprod.json` (the public-testnet equivalent of `deployment-standalone.json`).

## Troubleshooting (the seam)
The on-screen log names the exact failing call. Common ones:
- **`balanceUnsealedTransaction` rejects / tx decode error** → the serialized-tx encoding. The console sends
  **hex** (`toHex(tx.serialize())`). If your Lace build expects base64, change `toHex`/`fromHex` in
  `src/main.ts` to base64. (This is the one cross-version seam.)
- **proof-server CORS** (browser → `127.0.0.1:6300` blocked) → run the proof-server with CORS allowed, or
  put it behind a small proxy that adds `Access-Control-Allow-Origin: *`. Override the URL with
  `?proof=http://host:port`.
- **indexer WebSocket** errors → the console passes the browser-native `WebSocket`; if the provider still
  complains, it's the `isomorphic-ws` shim — surfaced in the log.
- **coinPublicKey format** → the console passes Lace's bech32m key; since Lace does the balancing this is
  usually irrelevant, but if midnight-js complains, it needs the hex form.

Ping me with the on-screen log line and I'll adjust `src/main.ts` — only this last handshake is unverified.

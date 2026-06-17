/**
 * DPO2U Midnight deploy console — deploy the 9 consolidated contracts to preprod via Lace.
 *
 * WHY THIS EXISTS: the headless WalletFacade full-sync of preprod OOM-kills this machine
 * (shielded 1.08M + dust history > 31GB RAM over hours). Lace syncs persistently inside the
 * extension, so the browser never pays that cost — it just asks Lace to balance + submit.
 *
 * SEAM (the one part not testable without a real Lace): the DApp Connector (dapp-connector-api
 * 4.0.1) speaks SERIALIZED transaction strings, and they line up exactly with midnight-js 4.1.1:
 *   - WalletProvider.balanceTx(tx: UnboundTransaction = Transaction<SignatureEnabled,Proof,PreBinding>)
 *     → connector.balanceUnsealedTransaction(serialize(tx)) → deserialize → FinalizedTransaction
 *   - MidnightProvider.submitTx(tx: FinalizedTransaction) → connector.submitTransaction(serialize(tx))
 * Proving stays on the LOCAL proof-server (Lace only balances + submits).
 *
 * If something fails in-browser, the failing call + payload are logged — that's the debug surface.
 */
import { Buffer } from 'buffer';
(globalThis as any).Buffer ??= Buffer;
(globalThis as any).global ??= globalThis;

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { Transaction } from '@midnight-ntwrk/ledger-v8';

import * as AgentRegistry from '../../build/AgentRegistry/contract/index.js';
import * as AgentWalletFactory from '../../build/AgentWalletFactory/contract/index.js';
import * as ComplianceRegistry from '../../build/ComplianceRegistry/contract/index.js';
import * as FeeDistributor from '../../build/FeeDistributor/contract/index.js';
import * as PaymentGateway from '../../build/PaymentGateway/contract/index.js';
import * as LgpdKitRegistry from '../../build/LgpdKitRegistry/contract/index.js';
import * as ConsentRegistry from '../../build/ConsentRegistry/contract/index.js';
import * as DataAuditLog from '../../build/DataAuditLog/contract/index.js';
import * as DataSubjectRights from '../../build/DataSubjectRights/contract/index.js';

const CONTRACTS: Array<{ name: string; mod: any }> = [
  { name: 'AgentRegistry', mod: AgentRegistry },
  { name: 'AgentWalletFactory', mod: AgentWalletFactory },
  { name: 'ComplianceRegistry', mod: ComplianceRegistry },
  { name: 'FeeDistributor', mod: FeeDistributor },
  { name: 'PaymentGateway', mod: PaymentGateway },
  { name: 'LgpdKitRegistry', mod: LgpdKitRegistry },
  { name: 'ConsentRegistry', mod: ConsentRegistry },
  { name: 'DataAuditLog', mod: DataAuditLog },
  { name: 'DataSubjectRights', mod: DataSubjectRights },
];

// Local proof-server (override with ?proof=http://host:port). Lace does NOT prove here.
const PROOF_SERVER = new URLSearchParams(location.search).get('proof') ?? 'http://127.0.0.1:6300';

// connect() must be called with the SAME network id Lace is configured for, else "Network ID
// mismatch". Lace labels the preprod testnet differently from midnight-js — try candidates until
// one matches. Override/extend with ?net=testnet,preprod
// Lace supports: mainnet, preprod, preview, qanet, undeployed. Preprod first.
const NET_CANDIDATES = (new URLSearchParams(location.search).get('net')?.split(',').filter(Boolean))
  ?? ['preprod', 'preview', 'qanet', 'undeployed', 'mainnet'];

// ── tiny DOM helpers ────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => { const el = $('log'); el.textContent += `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; el.scrollTop = el.scrollHeight; };
function pill(id: string, text: string, cls = '') { const el = $(id); el.textContent = text; el.className = `pill ${cls}`; }
const results: Record<string, any> = {};

function renderRows() {
  $('rows').innerHTML = CONTRACTS.map((c) => {
    const r = results[c.name];
    const st = r?.status ?? 'idle';
    const cell = r?.address
      ? `<span class="addr">${r.address}</span><br><small>block ${r.block} · tx ${r.tx}</small>`
      : r?.error ? `<span class="err">${r.error}</span>` : '';
    return `<tr><td>${c.name}</td><td class="status-${st}">${st}</td><td>${cell}</td></tr>`;
  }).join('');
}

// ── Lace DApp Connector discovery + connect ─────────────────────────────────
let connected: any = null;       // ConnectedAPI (WalletConnectedAPI)
let walletProvider: any = null;
let midnightProvider: any = null;
let publicDataProvider: any = null;
const privateStateProvider = makeInMemoryPrivateStateProvider();

function pickWallet(): { key: string; api: any } | null {
  const mn = (window as any).midnight;
  if (!mn) return null;
  // Prefer Lace ('mnLace'), else first injected wallet with a connect()/apiVersion.
  const entries = Object.entries(mn).filter(([, a]: any) => a && typeof a.connect === 'function');
  if (!entries.length) return null;
  const lace = entries.find(([k]) => /lace/i.test(k));
  const [key, api] = (lace ?? entries[0]) as [string, any];
  return { key, api };
}

async function connect() {
  pill('wallet', 'looking for Lace…', 'warn');
  const found = pickWallet();
  if (!found) { pill('wallet', 'Lace not found — install the extension', 'err'); log('window.midnight is empty. Is the Midnight Lace extension installed + unlocked?'); return; }
  log(`found wallet: ${found.key} (apiVersion ${found.api.apiVersion})`);

  // Try candidate network ids until Lace accepts one (matches its configured network).
  let lastErr: any = null;
  for (const net of NET_CANDIDATES) {
    try {
      log(`connect(networkId="${net}")…`);
      connected = await found.api.connect(net);
      log(`✓ connected with networkId="${net}"`);
      lastErr = null; break;
    } catch (e: any) {
      connected = null; lastErr = e;
      log(`  "${net}" rejected: ${e?.message ?? e}`);
    }
  }
  if (!connected) { pill('wallet', 'connect failed (network)', 'err'); throw lastErr; }

  const cfg = await connected.getConfiguration();
  log(`network=${cfg.networkId} indexer=${cfg.indexerUri}`);
  setNetworkId(cfg.networkId as any);

  const sh = await connected.getShieldedAddresses();
  const un = await connected.getUnshieldedAddress();
  const night = await connected.getUnshieldedBalances().catch(() => ({}));
  const dust = await connected.getDustBalance().catch(() => ({ balance: 0n, cap: 0n }));
  pill('wallet', `${un.unshieldedAddress.slice(0, 16)}…`, 'ok');
  pill('net', cfg.networkId, cfg.networkId === 'preprod' ? 'ok' : 'warn');
  pill('bal', `tNIGHT ${Object.values(night)[0] ?? 0} · tDUST ${dust.balance}`, (dust.balance ?? 0n) > 0n ? 'ok' : 'warn');
  if (!((dust.balance ?? 0n) > 0n)) log('⚠ tDUST is 0 — fees cannot be paid. In Lace: Tokens → Generate tDUST, wait ~1-2 min, then reconnect.');
  if (cfg.networkId !== 'preprod') log(`WARNING: Lace is on "${cfg.networkId}", not preprod. Switch the network in Lace settings.`);

  publicDataProvider = indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri, (window as any).WebSocket);

  // ── the connector → midnight-js seam ──
  walletProvider = {
    getCoinPublicKey: () => sh.shieldedCoinPublicKey,            // bech32m; connector balances, so format is best-effort
    getEncryptionPublicKey: () => sh.shieldedEncryptionPublicKey,
    async balanceTx(tx: any /* UnboundTransaction */): Promise<any /* FinalizedTransaction */> {
      const serialized = toHex(tx.serialize());
      log(`balanceTx → Lace.balanceUnsealedTransaction (${serialized.length / 2} bytes)`);
      const { tx: balancedHex } = await connected.balanceUnsealedTransaction(serialized, { payFees: true });
      // Lace returns a sealed, ready-to-submit tx = Transaction<SignatureEnabled, Proof, Binding>.
      return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balancedHex));
    },
  };
  midnightProvider = {
    async submitTx(tx: any /* FinalizedTransaction */): Promise<string> {
      const txId = tx.identifiers()[0] ?? tx.transactionHash();
      await connected.submitTransaction(toHex(tx.serialize()));
      log(`submitTx → Lace.submitTransaction ok (id ${String(txId).slice(0, 16)}…)`);
      return txId;
    },
  };

  ($('deployAll') as HTMLButtonElement).disabled = false;
  log('ready. Click "Deploy all 9" (each deploy = one Lace approval popup).');
}

async function deployOne(name: string, mod: any) {
  results[name] = { status: 'run' }; renderRows();
  try {
    const zkConfigProvider = new FetchZkConfigProvider(`${location.origin}/zk/${name}`, fetch.bind(window));
    const proofProvider = httpClientProofProvider(PROOF_SERVER, zkConfigProvider);
    const providers = { privateStateProvider, publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider };
    log(`[${name}] proving (local proof-server) + balancing (Lace) + submitting…`);
    // 4.1.1 wants a branded CompiledContract (compact-js), NOT a raw `new Contract()`.
    // ZK assets come from the zkConfigProvider, so we skip the Node-only withCompiledFileAssets.
    const compiled = CompiledContract.make(name, mod.Contract).pipe(CompiledContract.withVacantWitnesses);
    const deployed: any = await deployContract(providers as any, {
      compiledContract: compiled,
      privateStateId: `${name}PrivateState`,
      initialPrivateState: {},
    });
    const d = deployed.deployTxData.public;
    results[name] = { status: 'done', address: d.contractAddress, block: d.blockHeight, tx: d.txId };
    log(`[${name}] DEPLOYED → ${d.contractAddress} (block ${d.blockHeight})`);
  } catch (e: any) {
    // Lace/ledger errors often surface as a bare "Error" — dig out name/code/info + own props.
    const parts = [e?.name, e?.message].filter(Boolean).join(': ') || String(e);
    let extra = '';
    try { const o = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); if (o && o !== '{}') extra = ' | ' + o; } catch {}
    const cause = e?.cause ? ` | cause: ${e.cause?.message ?? e.cause}` : '';
    results[name] = { status: 'fail', error: parts };
    log(`[${name}] FAILED: ${parts}${cause}${extra}`);
    if (/insufficient|dust|fee|balance/i.test(parts + extra)) log(`  → looks fee/dust related: confirm the tDUST pill is > 0 (Lace → Generate tDUST).`);
  }
  renderRows();
  ($('export') as HTMLButtonElement).disabled = false;
}

async function deployAll() {
  ($('deployAll') as HTMLButtonElement).disabled = true;
  for (const c of CONTRACTS) await deployOne(c.name, c.mod);  // sequential — one approval at a time
  ($('deployAll') as HTMLButtonElement).disabled = false;
  log(`done: ${Object.values(results).filter((r: any) => r.status === 'done').length}/9 deployed.`);
}

function exportJson() {
  const out = {
    network: 'preprod', deployedAt: new Date().toISOString(),
    contracts: CONTRACTS.map((c) => ({ name: c.name, ...(results[c.name] ?? {}) })),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'deployment-preprod.json'; a.click();
}

// minimal in-memory private state provider (no IndexedDB provider ships for the browser;
// deploy only needs set/get of an empty initial state).
function makeInMemoryPrivateStateProvider() {
  const ps = new Map<string, any>(); const keys = new Map<string, any>();
  return {
    set: async (id: string, s: any) => void ps.set(id, s),
    get: async (id: string) => ps.get(id) ?? null,
    remove: async (id: string) => void ps.delete(id),
    clear: async () => void ps.clear(),
    setSigningKey: async (a: string, k: any) => void keys.set(a, k),
    getSigningKey: async (a: string) => keys.get(a) ?? null,
    removeSigningKey: async (a: string) => void keys.delete(a),
    clearSigningKeys: async () => void keys.clear(),
  } as any;
}

$('connect').addEventListener('click', () => connect().catch((e) => { log('connect error: ' + (e?.stack ?? e)); pill('wallet', 'connect failed', 'err'); }));
$('deployAll').addEventListener('click', () => deployAll().catch((e) => log('deploy error: ' + e)));
$('export').addEventListener('click', exportJson);
renderRows();
log(`DPO2U deploy console ready. Proof-server: ${PROOF_SERVER}. Click "Connect Lace" to begin.`);

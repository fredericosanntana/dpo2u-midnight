/**
 * attest-lgpd-v9.ts — executor da atestação da Trilha de Adequação LGPD no
 * Midnight PREVIEW, SDK de geração ledger-v9 (midnight-js 5, wallet-sdk 5,
 * compact-js 3, compactc 0.36.0 / compact-runtime 0.21.0). Só testnet.
 *
 * O preview foi resetado após 06/11/2026 e passou ao ledger v9 (protocolVersion
 * 2001100); o SDK v8 não decodifica os eventos novos. Esta versão substitui
 * attest-lgpd.ts no mesmo contrato de entrada/saída usado pela tool MCP
 * submit_lgpd_attestation:
 *   stdin  JSON { manifestHash, packId, verdict, attestedAt, reviewerHash, reportId }
 *   stdout última linha JSON { txId, blockHeight, contract, circuit, useCaseId, metadataHash, onchain }
 *
 * Mapeamento em ComplianceRegistry.attestUseCase(use_case_id, verdict, evidence_hash, metadata_hash):
 *   use_case_id = sha256("dpo2u/lgpd-attestation/v1|" + packId); verdict 1 PASS / 0 FAIL / 2 REVIEW;
 *   evidence_hash = manifestHash; metadata_hash = sha256(JSON canônico {attestedAt, packId, reportId, reviewerHash, verdict}).
 *
 * Endereço do contrato: env COMPLIANCE_REGISTRY_ADDRESS > deployment-<rede>-lgpd-attestations.json >
 * deploy novo (só com ALLOW_DEPLOY=1). Seed só por env (MIDNIGHT_SEED), nunca impresso.
 * Checkpoint da carteira em wallet-checkpoint/<rede>-v9/ (600). Rede via MIDNIGHT_NETWORK (padrão preview).
 */
import 'dotenv/config';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { createLedger9WalletProvider, createLedger9MidnightProvider } from '@midnight-ntwrk/midnight-js-types';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ownerSecret, ownerWitnesses, ownerCommit } from './owner.js';
import { networkConfig } from './lib/midnight-v9.js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletSeeds } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// @ts-expect-error WebSocket polyfill para o graphql-ws do wallet sync
globalThis.WebSocket = WebSocket;

// Rede: MIDNIGHT_NETWORK (preview | preprod | mainnet; padrão preview). Mainnet só passa pela trava de
// scripts/lib/midnight-v9.ts. O proof server deste executor roda na 6311 por padrão (proof-server 9.0.1).
process.env.PROOF_SERVER_URL ??= 'http://127.0.0.1:6311';
const NET = networkConfig();
const NETWORK_ID = NET.networkId;
const CFG = { indexer: NET.indexer, indexerWS: NET.indexerWS, node: NET.node, proofServer: NET.proofServer };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, `deployment-${NET.name}-lgpd-attestations.json`);
const CK = path.join(ROOT, 'wallet-checkpoint', `${NET.name}-v9`);
// Artefatos do compactc 0.36.0: LGPD_ZK_DIR > build-v9/ (worktree LGPD) > build/ (branch feat/midnight-ledger-v9, compile.sh 0.36.0).
const ZK = process.env.LGPD_ZK_DIR
  ?? (fs.existsSync(path.join(ROOT, 'build-v9', 'ComplianceRegistry')) ? path.join(ROOT, 'build-v9', 'ComplianceRegistry') : path.join(ROOT, 'build', 'ComplianceRegistry'));
const VERDICT: Record<string, bigint> = { fail: 0n, pass: 1n, review: 2n };

const log = (...a: unknown[]) => console.error(...a); // progresso no stderr; stdout só a linha JSON final
function canonicalJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const fromHex = (h: string) => { if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('hash hex de 32 bytes esperado'); return new Uint8Array(Buffer.from(h, 'hex')); };
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };

async function saveCheckpoint(wallet: any) {
  try {
    fs.mkdirSync(CK, { recursive: true, mode: 0o700 });
    for (const [k, api] of [['shielded', wallet.shielded], ['unshielded', wallet.unshielded], ['dust', wallet.dust]] as const) {
      const blob = await (api as any).serializeState();
      fs.writeFileSync(path.join(CK, `${k}.json`), typeof blob === 'string' ? blob : JSON.stringify(blob), { mode: 0o600 });
    }
    log('[wallet] checkpoint salvo');
  } catch (e: any) { log(`[wallet] checkpoint falhou: ${e?.message ?? e}`); }
}

async function createWallet(seedHex: string) {
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(seedHex, 'hex'));
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded } as any, NETWORK_ID as any);
  const restoring = ['shielded', 'unshielded', 'dust'].every((k) => fs.existsSync(path.join(CK, `${k}.json`)));
  const blob = (k: string) => fs.readFileSync(path.join(CK, `${k}.json`), 'utf8');
  if (restoring) log('[wallet] checkpoint v9 encontrado — delta sync');
  const configuration: any = {
    networkId: NETWORK_ID,
    indexerClientConnection: { indexerHttpUrl: CFG.indexer, indexerWsUrl: CFG.indexerWS },
    provingServerUrl: new URL(CFG.proofServer),
    relayURL: new URL(CFG.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema as any, mergeWalletEntries as any),
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (c: any) => (restoring ? ShieldedWallet(c).restore(blob('shielded')) : ShieldedWallet(c).startWithSeed(seeds.shielded)) as any,
    unshielded: (c: any) => (restoring ? UnshieldedWallet(c).restore(blob('unshielded')) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore))) as any,
    dust: (c: any) => (restoring ? DustWallet(c).restore(blob('dust')) : DustWallet(c).startWithSeed(seeds.dust)) as any,
  } as any);
  await wallet.start(seeds);
  return { wallet, keystore };
}

async function waitForSync(wallet: any) {
  log('[sync] sincronizando (shielded + unshielded + dust)...');
  const sub = wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
    log(`  [${new Date().toISOString().slice(11, 19)}] synced=${s.isSynced} protocol=${s.activeProtocolVersion ?? '?'}`);
  });
  const state = await wallet.waitForSyncedState();
  sub.unsubscribe();
  log('[sync] sincronizado.');
  return state;
}

async function ensureDust(ctx: { wallet: any; keystore: any }, state: any) {
  const coins: any[] = state.unshielded?.availableCoins ?? [];
  const unregistered = coins.filter((u: any) => !u.meta?.registeredForDustGeneration);
  const sign = async (d: Uint8Array) => ctx.keystore.signData(d);
  if (unregistered.length > 0) {
    log(`[dust] registrando ${unregistered.length} UTxO(s) de NIGHT para gerar DUST...`);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(unregistered, ctx.keystore.getPublicKey(), sign);
    const tx = await ctx.wallet.finalizeRecipe(recipe);
    log(`[dust] registro enviado: ${await ctx.wallet.submitTransaction(tx)}`);
  } else {
    log('[dust] NIGHT já registrado para DUST');
  }
  // Espera o DUST parar de crescer (platô) ou atingir DUST_MIN; registra o saldo a cada 15 s.
  const dustOf = (st: any) => { try { return BigInt(st.dust.balance(new Date())); } catch { return 0n; } };
  const min = BigInt(process.env.DUST_MIN ?? '1');
  const maxWaitMs = Number(process.env.DUST_MAX_WAIT_MS ?? 10 * 60_000);
  const t0 = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((st: any) => {
      const bal = dustOf(st);
      const el = Date.now() - t0;
      log(`  [dust ${new Date().toISOString().slice(11, 19)}] saldo ${bal} (${Math.round(el / 1000)} s)`);
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal >= min && stable >= 2) || el >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  log('[dust] ok');
}

async function main() {
  const ComplianceRegistry: any = await import(pathToFileURL(path.join(ZK, 'contract', 'index.js')).href);
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const raw = await readStdin();
  const p = process.env.SYNC_ONLY === '1' ? { manifestHash: '0'.repeat(64), packId: 'sync', verdict: 'review', attestedAt: 'x', reviewerHash: '0'.repeat(64), reportId: 'sync' } : JSON.parse(raw);
  for (const k of ['manifestHash', 'packId', 'verdict', 'attestedAt', 'reviewerHash', 'reportId']) if (!p[k]) throw new Error(`payload sem ${k}`);
  if (!(p.verdict in VERDICT)) throw new Error('verdict inválido');
  const useCase = sha(`dpo2u/lgpd-attestation/v1|${p.packId}`);
  const evidence = fromHex(p.manifestHash);
  fromHex(p.reviewerHash);
  const meta = { attestedAt: p.attestedAt, packId: p.packId, reportId: p.reportId, reviewerHash: p.reviewerHash, verdict: p.verdict };
  const metadata = sha(canonicalJson(meta));

  const ctx = await createWallet(seed);
  const addr = String(ctx.keystore.getBech32Address());
  log(`wallet ${addr}`);
  if (process.env.EXPECT_ADDRESS && addr !== process.env.EXPECT_ADDRESS) throw new Error(`endereço derivado difere do esperado`);
  const state: any = await waitForSync(ctx.wallet);
  await saveCheckpoint(ctx.wallet);
  if (process.env.SYNC_ONLY === '1') {
    console.log(JSON.stringify({ address: addr, synced: true }));
    process.exit(0);
  }
  await ensureDust(ctx, state);

  const sign = async (d: Uint8Array) => ctx.keystore.signData(d);
  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    balanceTx: async (tx: any, ttl?: Date) => {
      const handle = ctx.wallet.adoptTransaction(tx.serialize(), 'Unbound');
      const recipe = await ctx.wallet.balanceUnboundTransaction(handle, { ttl: ttl ?? new Date(Date.now() + 30 * 60_000) });
      const signed = await ctx.wallet.signRecipe(recipe, sign);
      const fin: any = await ctx.wallet.finalizeRecipe(signed);
      return fin.serialize();
    },
  } as any);
  const midnightProvider = createLedger9MidnightProvider(async (tx: any) => {
    const handle = ctx.wallet.adoptTransaction(tx.serialize(), 'Finalized');
    try {
      return (await ctx.wallet.submitTransaction(handle)) as any;
    } catch (e: any) {
      log('[submit] falha:\n' + causes(e));
      throw e;
    }
  });
  const zkConfigProvider = new NodeZkConfigProvider(ZK);
  const providers: any = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'ComplianceRegistry-v9-state',
      privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD ?? (NET.name === 'mainnet' ? (() => { throw new Error('PRIVATE_STATE_PASSWORD required on mainnet'); })() : 'dpo2u-local-dev-private-state-pw-2026'),
      accountId: addr,
    } as any),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CFG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider,
    config: { networkId: NETWORK_ID, ttlSeconds: 1800 },
  };
  const compiled = (CompiledContract.make('ComplianceRegistry', (ComplianceRegistry as any).Contract) as any).pipe(
    (CompiledContract as any).withWitnesses(ownerWitnesses(ownerSecret(seed))), (CompiledContract as any).withCompiledFileAssets(ZK));

  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { network: NET.name, attestations: [] };
  // Only reuse a recorded contract deployed with access control; the older owner-less one cannot be called with this build.
  const recorded = out.complianceRegistry?.accessControl === 'owner-v1' ? out.complianceRegistry.contractAddress : undefined;
  let contractAddress: string | undefined = process.env.COMPLIANCE_REGISTRY_ADDRESS ?? recorded;
  let c: any;
  if (!contractAddress) {
    if (process.env.ALLOW_DEPLOY !== '1') throw new Error(`ComplianceRegistry sem endereço em ${NET.name}; rode com ALLOW_DEPLOY=1`);
    log(`[deploy] ComplianceRegistry (${NET.name}, ledger v9)`);
    c = await (deployContract as any)(providers, { compiledContract: compiled, privateStateId: 'ComplianceRegistryPS', initialPrivateState: {}, args: [ownerCommit(ComplianceRegistry, ownerSecret(seed))] });
    const d = c.deployTxData.public;
    contractAddress = String(d.contractAddress);
    out.complianceRegistry = { contractAddress, deployTxId: d.txId, blockHeight: d.blockHeight, deployedAt: new Date().toISOString(), compiler: 'compactc 0.36.0', ledger: 'v9', accessControl: 'owner-v1' };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    log(`  ComplianceRegistry ${contractAddress} tx ${d.txId} bloco ${d.blockHeight}`);
  } else {
    c = await (findDeployedContract as any)(providers, { contractAddress, compiledContract: compiled, privateStateId: 'ComplianceRegistryPS', initialPrivateState: {} });
  }

  const r = await c.callTx.attestUseCase(useCase, VERDICT[p.verdict], evidence, metadata);
  const d = r.public ?? {};
  const read: any = await providers.publicDataProvider.queryContractState(contractAddress);
  const L: any = (ComplianceRegistry as any).ledger(read.contractState.deserialize({ v9: ContractState }).data);
  const onchain = {
    usecase_verdict: String(L.usecase_verdicts.lookup(evidence)),
    usecase_id: hx(L.usecase_ids.lookup(evidence)),
    metadata_hash: hx(L.usecase_metadata.lookup(evidence)),
    usecase_attestation_count: String(L.usecase_attestation_count),
  };
  const rec = { label: `attestUseCase(lgpd ${p.packId}, verdict=${p.verdict}, evidence=${p.manifestHash.slice(0, 12)}…)`, txId: d.txId, blockHeight: d.blockHeight, contract: contractAddress, circuit: 'attestUseCase', useCaseId: hx(useCase), evidenceHash: p.manifestHash, metadataHash: hx(metadata), metadata: meta, onchain, at: new Date().toISOString() };
  out.attestations = out.attestations ?? [];
  out.attestations.push(rec);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  await saveCheckpoint(ctx.wallet);
  try { await (ctx.wallet as any).stop?.(); } catch { /* ignore */ }
  console.log(JSON.stringify({ txId: d.txId, blockHeight: d.blockHeight, contract: contractAddress, circuit: 'attestUseCase', useCaseId: hx(useCase), metadataHash: hx(metadata), onchain }));
  process.exit(0);
}
function causes(e: any, depth = 0): string {
  if (!e || depth > 6) return '';
  const head = `${'  '.repeat(depth)}- ${e?.name ?? e?._tag ?? typeof e}: ${String(e?.message ?? e).slice(0, 600)}`;
  return head + '\n' + causes(e?.cause ?? e?.error, depth + 1);
}
main().catch((err) => { console.error('attest-lgpd-v9 falhou:\n' + causes(err)); console.error(err?.stack); process.exit(1); });

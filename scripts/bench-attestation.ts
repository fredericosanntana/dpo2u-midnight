/**
 * Attestation benchmark on a network: N runs of each workload, end-to-end latency (prove + submit +
 * inclusion: the time callTx takes to resolve with the block) p50/p95, and DUST per tx (wallet
 * balance delta and the wallet's estimateTransactionFee for the same tx). Writes
 * benchmarks/<network>-<date>.json with the network, first/last tx block, versions (compactc,
 * runtime, proof server, node), proof-server hardware, the deploy baseline imported from
 * deployment-preprod-v9.json, and a DECLARED DUST -> NIGHT -> USD conversion (no price is fetched).
 *
 *   MIDNIGHT_NETWORK=preprod npx tsx scripts/bench-attestation.ts --runs 10 --plan
 *   MIDNIGHT_NETWORK=preprod npx tsx scripts/bench-attestation.ts --runs 10 \
 *       --night-usd 0.05 --night-usd-source "<exchange or index>" --night-usd-date 2026-11-13
 *
 * Workloads (--workloads, default all available):
 *   attestCompliance  ComplianceRegistry, company TRAVEL_RULE_SELF_COMPANY_ID (or bench-company), fresh context per run
 *   attestUseCase     ComplianceRegistry, fresh evidence hash per run
 *   gate              TravelRuleGate v10 evaluateTransfer + releaseTransfer, only when the deployment file has a
 *                     v10 gate AND scripts/lib/travel-rule-v10.ts is present (branch feat/v10-gate-network);
 *                     otherwise reported as skipped with the reason
 * Options: --runs N (5) --out FILE --baseline FILE (deployment-preprod-v9.json) --specks-per-dust N (10^15)
 *   --dust-per-night N (5) --night-usd P --night-usd-source S --night-usd-date YYYY-MM-DD
 *   --proof-server-version V --proof-server-hardware JSON (when the proof server is not on this host)
 * Every tx uses fictitious data. Mainnet keeps the guard of scripts/lib/midnight-v9.ts.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { networkConfig, openWallet, ensureDust, makeProviders, masterSeedHex, dustBalance, CODE_VERSION, type V9Wallet } from './lib/midnight-v9.js';
import { ownerSecret, ownerWitnesses, scoreSalt, setScoreSalt } from './owner.js';
import { newProviderKey, signSanctionsList, sanctionsListRoot } from './lib/sanctions-list.js';
import { summarize, makeConversion, convert, deployBaseline, compiledVersions, packageVersion, hostHardware, isLocalUrl, benchFile, type Sample } from './lib/bench.js';

// @ts-expect-error WebSocket polyfill for graphql-ws in Node
globalThis.WebSocket = WebSocket;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    plan: { type: 'boolean', default: false }, runs: { type: 'string', default: '5' }, workloads: { type: 'string' }, out: { type: 'string' },
    baseline: { type: 'string' }, 'specks-per-dust': { type: 'string' }, 'dust-per-night': { type: 'string' },
    'night-usd': { type: 'string' }, 'night-usd-source': { type: 'string' }, 'night-usd-date': { type: 'string' },
    'proof-server-version': { type: 'string' }, 'proof-server-hardware': { type: 'string' },
  },
});

const ALL = ['attestCompliance', 'attestUseCase', 'gate'] as const;
const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(Buffer.byteLength(s), 32)); return new Uint8Array(b); };
const h32 = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

async function gateSupport(net: string): Promise<{ ok: true; lib: any; dep: any } | { ok: false; reason: string }> {
  const libPath = path.join(ROOT, 'scripts', 'lib', 'travel-rule-v10.ts');
  if (!fs.existsSync(libPath)) return { ok: false, reason: 'scripts/lib/travel-rule-v10.ts not on this branch (feat/v10-gate-network)' };
  const lib = await import(pathToFileURL(libPath).href);
  try { return { ok: true, lib, dep: lib.readGateDeployment(ROOT, net) }; } catch (e: any) { return { ok: false, reason: e.message }; }
}

function registryAddress(net: string): string {
  const f = path.join(ROOT, `deployment-${net}-v9.json`);
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).contracts?.ComplianceRegistry : undefined;
  if (!c?.contractAddress) throw new Error(`ComplianceRegistry not in ${path.basename(f)}`);
  if (c.codeVersion !== CODE_VERSION) throw new Error(`ComplianceRegistry in ${path.basename(f)} is pre-${CODE_VERSION} (attestCompliance signature differs); redeploy first`);
  return c.contractAddress;
}

async function main() {
  // --plan needs no endpoints (and no Blockfrost id): only the network name and the proof server URL.
  const net = values.plan
    ? { name: process.env.MIDNIGHT_NETWORK ?? 'preview', proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300' } as any
    : networkConfig();
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) throw new Error('--runs must be 1..200');
  const conv = makeConversion({ specksPerDust: values['specks-per-dust'], dustPerNight: values['dust-per-night'] ? Number(values['dust-per-night']) : undefined,
    nightUsd: values['night-usd'], nightUsdSource: values['night-usd-source'], nightUsdDate: values['night-usd-date'] });
  const wanted = (values.workloads ?? ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const w of wanted) if (!(ALL as readonly string[]).includes(w)) throw new Error(`unknown workload ${w}`);
  const gate = wanted.includes('gate') ? await gateSupport(net.name) : { ok: false as const, reason: 'not requested' };
  const workloads = wanted.filter((w) => w !== 'gate' || gate.ok);
  const skipped = gate.ok || !wanted.includes('gate') ? [] : [{ workload: 'gate', reason: gate.reason }];
  const baseline = deployBaseline(values.baseline ?? path.join(ROOT, 'deployment-preprod-v9.json'), conv);
  const versions = {
    contracts: compiledVersions(ROOT, ['ComplianceRegistry', 'TravelRuleGate', 'PsavPassport']),
    compactRuntime: packageVersion(ROOT, '@midnight-ntwrk/compact-runtime'), midnightJsContracts: packageVersion(ROOT, '@midnight-ntwrk/midnight-js-contracts'),
    ledger: packageVersion(ROOT, '@midnightntwrk/ledger-v9'), node: process.version, proofServer: values['proof-server-version'] ?? null,
  };
  const proofHw = values['proof-server-hardware'] ? JSON.parse(values['proof-server-hardware']) : isLocalUrl(net.proofServer) ? { ...hostHardware(), source: 'this host (proof server is local)' } : null;
  const out = values.out ?? benchFile(ROOT, net.name);

  if (values.plan) {
    let registry: string | null = null, registryError: string | null = null;
    try { registry = registryAddress(net.name); } catch (e: any) { registryError = e.message; }
    console.log(JSON.stringify({ plan: {
      network: net.name, runs, workloads, skipped, txs: workloads.reduce((n, w) => n + (w === 'gate' ? 2 * runs + 1 : runs), 0),
      registry, registryError, gate: gate.ok ? gate.dep.gate : null,
      measures: ['latency_ms per tx: callTx start -> resolved with block (prove + submit + inclusion)', 'dust per tx: wallet balance delta (under-states) and facade.estimateTransactionFee'],
      conversion: conv, deployBaseline: baseline, versions, proofServerHardware: proofHw, out: path.relative(ROOT, out),
    } }, null, 2));
    return;
  }

  const w = await openWallet(net);
  const samples: Sample[] = [];
  try {
    if ((await ensureDust(w)) === 0n) throw new Error('No DUST in the wallet');
    if (!versions.proofServer) {
      try { const r = await fetch(new URL('/version', net.proofServer), { signal: AbortSignal.timeout(5000) }); if (r.ok) versions.proofServer = (await r.text()).trim().slice(0, 80); } catch { /* recorded as null */ }
    }
    const secret = ownerSecret(masterSeedHex());
    let lastEstimate: bigint | null = null;
    const withFeeEstimate = (providers: any) => {
      const orig = providers.walletProvider;
      const wrapped = Object.create(orig);
      wrapped.balanceTx = async (tx: any, ttl?: Date) => {
        lastEstimate = null;
        try { lastEstimate = await (w.facade as any).estimateTransactionFee((w.facade as any).adoptTransaction(tx.serialize(), 'Unbound')); } catch { /* estimate unavailable for this tx */ }
        return orig.balanceTx(tx, ttl);
      };
      return { ...providers, walletProvider: wrapped };
    };
    const balance = async () => dustBalance(await Rx.firstValueFrom(w.facade.state()));
    const measure = async (workload: string, i: number, call: () => Promise<any>) => {
      const before = await balance();
      const t0 = Date.now();
      try {
        const r = await call();
        const ms = Date.now() - t0;
        const after = await balance();
        samples.push({ workload, i, ok: true, ms, dustDelta: (before - after).toString(), feeEstimate: lastEstimate?.toString() ?? null, txId: r?.public?.txId, blockHeight: r?.public?.blockHeight });
      } catch (e: any) {
        samples.push({ workload, i, ok: false, ms: Date.now() - t0, dustDelta: null, feeEstimate: null, error: String(e?.message ?? e).slice(0, 300) });
      }
      console.error(`[bench] ${workload} #${i}: ${samples.at(-1)!.ok ? samples.at(-1)!.ms + ' ms' : 'FAILED ' + samples.at(-1)!.error}`);
    };

    const tag = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const self = (process.env.TRAVEL_RULE_SELF_COMPANY_ID ?? 'bench-company').trim();
    if (workloads.includes('attestCompliance') || workloads.includes('attestUseCase')) {
      const zk = path.join(ROOT, 'build', 'ComplianceRegistry');
      const mod = await import(pathToFileURL(path.join(zk, 'contract', 'index.js')).href);
      const compiled = (CompiledContract.make('ComplianceRegistry', mod.Contract) as any).pipe((CompiledContract as any).withWitnesses(ownerWitnesses(secret)), (CompiledContract as any).withCompiledFileAssets(zk));
      const cr: any = await (findDeployedContract as any)(withFeeEstimate(makeProviders(w, zk, 'ComplianceRegistry-bench')), { contractAddress: registryAddress(net.name), compiledContract: compiled, privateStateId: 'ComplianceRegistryPrivateState', initialPrivateState: {} });
      for (let i = 0; i < runs; i++) {
        if (workloads.includes('attestCompliance')) {
          const ctx = h32(`bench|${tag}|ctx|${i}`);
          setScoreSalt(scoreSalt(secret, ctx));
          await measure('attestCompliance', i, () => cr.callTx.attestCompliance(b32(self), b32('did:dpo2u:bench'), b32('bench-policy'), 70n, ctx, 85n, h32(`bench|${tag}|evidence|${i}`)).finally(() => setScoreSalt(undefined)));
        }
        if (workloads.includes('attestUseCase')) {
          await measure('attestUseCase', i, () => cr.callTx.attestUseCase(b32('bench_usecase_v1'), 1n, h32(`bench|${tag}|uc|${i}`), h32(`bench|${tag}|meta|${i}`)));
        }
      }
    }
    if (gate.ok) await runGate(w, gate, runs, tag, secret, withFeeEstimate, measure);
  } finally {
    await (w.facade as any).stop?.();
  }

  const blocks = samples.filter((s) => s.blockHeight !== undefined).map((s) => s.blockHeight!);
  const summary = summarize(samples);
  const report = {
    kind: 'attestation-benchmark', generatedAt: new Date().toISOString(), network: net.name, runs, workloads, skipped,
    blocks: { first: blocks.length ? Math.min(...blocks) : null, last: blocks.length ? Math.max(...blocks) : null, note: 'blocks of the first and last measured tx' },
    versions, proofServerHardware: proofHw, conversion: conv,
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]: [string, any]) => [k, { ...v, converted: { balance_delta_median: convert(v.dust_per_tx_specks.balance_delta_median, conv), estimate_median: convert(v.dust_per_tx_specks.estimate_median, conv) } }])),
    deployBaseline: baseline, samples,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out: path.relative(ROOT, out), summary: report.summary }));
}

/** TravelRuleGate v10: one attestVasp and one registerSanctionsProvider with a bench-only key and a
 * fictitious signed list (not measured), then evaluate + release per run. Release needs self_company_id attested (attestCompliance workload). */
async function runGate(w: V9Wallet, g: { lib: any; dep: any }, runs: number, tag: string, secret: Uint8Array, withFee: (p: any) => any, measure: (wl: string, i: number, f: () => Promise<any>) => Promise<void>) {
  const { lib, dep } = g;
  const { ZKConfigRegistry } = await import('@midnight-ntwrk/midnight-js-types');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  const zk = path.join(ROOT, 'build', 'TravelRuleGate');
  const base = makeProviders(w, zk, 'TravelRuleGate-bench');
  const providers = withFee({ ...base, contractModuleProvider: lib.moduleProviderFor(ROOT, dep.links),
    proofProvider: httpClientProofProvider({ url: w.net.proofServer, zkConfigProvider: new ZKConfigRegistry(lib.zkDirs(ROOT).map((d: string) => new NodeZkConfigProvider(d))) } as any) });
  const party = (n: string, vasp: Uint8Array) => ({ name_hash: h32('name:' + n), account_hash: h32('acct:' + n), doc_hash: h32('doc:' + n), vasp_id: vasp, salt: h32('salt:' + n) });
  const counterparty = b32(`vasp:bench-${tag}`.slice(0, 32));
  let cur = { o: party(`o-${tag}`, b32('vasp:bench-own')), b: party(`b-${tag}`, counterparty) };
  const mod = await import(pathToFileURL(path.join(zk, 'contract', 'index.js')).href);
  // evaluateTransfer requires a sanctions list signed by a registered provider (witness sanctions_list).
  const provider = newProviderKey();
  const providerId = h32(`bench|${tag}|sanctions-provider`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const list = signSanctionsList(mod as any, provider.sk, { provider_id: providerId, list_root: sanctionsListRoot([createHash('sha256').update(`bench|${tag}|entry`).digest('hex')]), issued_at: now - 3600n, valid_until: now + 86_400n });
  const refuse = (n: string) => () => { throw new Error(`witness ${n} not used by the bench`); };
  const compiled = (CompiledContract.make('TravelRuleGate', mod.Contract) as any).pipe((CompiledContract as any).withWitnesses({
    owner_secret: (x: any) => [x.privateState, secret], approver_secret: refuse('approver_secret'),
    originator_data: (x: any) => [x.privateState, cur.o], beneficiary_data: (x: any) => [x.privateState, cur.b],
    transfer_amount: (x: any) => [x.privateState, 250_000n], sanctions_clear: (x: any) => [x.privateState, true],
    sanctions_list: (x: any) => [x.privateState, list],
  }), (CompiledContract as any).withCompiledFileAssets(zk));
  const gate: any = await (findDeployedContract as any)(providers, { contractAddress: dep.gate, compiledContract: compiled, privateStateId: 'TravelRuleGatePrivateState', initialPrivateState: {} });
  await gate.callTx.attestVasp(counterparty);
  await gate.callTx.registerSanctionsProvider(providerId, provider.pk);
  for (let i = 0; i < runs; i++) {
    cur = { o: party(`o-${tag}-${i}`, b32('vasp:bench-own')), b: party(`b-${tag}-${i}`, counterparty) };
    const t = h32(`bench|${tag}|transfer|${i}`);
    await measure('evaluateTransfer', i, () => gate.callTx.evaluateTransfer(t, h32('policy:bench')));
    await measure('releaseTransfer', i, () => gate.callTx.releaseTransfer(t));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });

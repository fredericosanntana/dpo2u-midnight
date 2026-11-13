/**
 * Attestation benchmark: the pure part (no wallet, no network), unit-tested.
 * Statistics, the declared DUST -> NIGHT -> USD conversion, the deploy baseline imported from a
 * deployment file, versions read from the compiled contracts, and the report shape written to
 * benchmarks/<network>-<date>.json by scripts/bench-attestation.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Sample = { workload: string; i: number; ok: boolean; ms: number; dustDelta: string | null; feeEstimate: string | null; txId?: string; blockHeight?: number; error?: string };

/** Nearest-rank percentile of a list of numbers (p in 0..100). */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

const big = (v: string | null) => (v === null ? null : BigInt(v));
const median = (xs: bigint[]): bigint | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)];
};

/** Per-workload summary: latency p50/p95 (ok runs only), DUST per tx (median of balance delta and of the estimate). */
export function summarize(samples: Sample[]) {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.workload, [...(by.get(s.workload) ?? []), s]);
  return Object.fromEntries([...by].map(([w, ss]) => {
    const ok = ss.filter((s) => s.ok);
    const deltas = ok.map((s) => big(s.dustDelta)).filter((x): x is bigint => x !== null && x > 0n);
    const est = ok.map((s) => big(s.feeEstimate)).filter((x): x is bigint => x !== null);
    return [w, {
      runs: ss.length, ok: ok.length, failed: ss.length - ok.length,
      latency_ms: { p50: percentile(ok.map((s) => s.ms), 50), p95: percentile(ok.map((s) => s.ms), 95), min: ok.length ? Math.min(...ok.map((s) => s.ms)) : null, max: ok.length ? Math.max(...ok.map((s) => s.ms)) : null },
      // Balance delta under-states the fee: DUST keeps generating while the tx runs. Non-positive deltas are dropped.
      dust_per_tx_specks: { balance_delta_median: median(deltas)?.toString() ?? null, estimate_median: median(est)?.toString() ?? null, balance_delta_samples: deltas.length, estimate_samples: est.length },
    }];
  }));
}

/**
 * Declared conversion, never fetched: DUST is not transferable and has no market price. The NIGHT
 * figure is the NIGHT that must be held to have this much DUST capacity (dustPerNight), and the USD
 * figure prices that NIGHT at the price the operator passed, with its source and date.
 */
export type Conversion = { specksPerDust: string; dustPerNight: number; nightUsd: number | null; nightUsdSource: string | null; nightUsdDate: string | null; basis: string };

export function makeConversion(o: { specksPerDust?: string; dustPerNight?: number; nightUsd?: string; nightUsdSource?: string; nightUsdDate?: string }): Conversion {
  const price = o.nightUsd === undefined ? null : Number(o.nightUsd);
  if (price !== null && (!Number.isFinite(price) || price <= 0)) throw new Error('--night-usd must be a positive number');
  if (price !== null && (!o.nightUsdSource || !o.nightUsdDate)) throw new Error('--night-usd needs --night-usd-source and --night-usd-date (no price without its source and date)');
  if (o.nightUsdDate && Number.isNaN(Date.parse(o.nightUsdDate))) throw new Error('--night-usd-date must be a date (YYYY-MM-DD)');
  return {
    specksPerDust: o.specksPerDust ?? (10n ** 15n).toString(),
    dustPerNight: o.dustPerNight ?? 5,
    nightUsd: price, nightUsdSource: price === null ? null : o.nightUsdSource!, nightUsdDate: price === null ? null : o.nightUsdDate!,
    basis: 'Declared parameters, not market data: specksPerDust and dustPerNight (DUST capacity per NIGHT held) as passed or defaulted; NIGHT price only as passed with source and date. DUST itself is not transferable and has no price.',
  };
}

export function convert(specks: string | null, c: Conversion) {
  if (specks === null) return null;
  const dust = Number(BigInt(specks)) / Number(BigInt(c.specksPerDust));
  const night = dust / c.dustPerNight;
  return { specks, dust, night_held_equivalent: night, usd: c.nightUsd === null ? null : night * c.nightUsd };
}

/** dustSpent of each contract in a deployment file, as a DEPLOY baseline (not an attestation cost). */
export function deployBaseline(file: string, c: Conversion) {
  if (!fs.existsSync(file)) return { source: path.basename(file), kind: 'deploy-baseline', note: 'file not found', contracts: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const contracts = Object.fromEntries(Object.entries<any>(j.contracts ?? {}).filter(([, v]) => v?.dustSpent).map(([k, v]) => [k, {
    dustSpent_specks: String(v.dustSpent), seconds: v.seconds ?? null, blockHeight: v.blockHeight ?? null, deployedAt: v.deployedAt ?? null, converted: convert(String(v.dustSpent), c),
  }]));
  return { source: path.basename(file), network: j.network ?? null, kind: 'deploy-baseline',
    note: 'Imported as measured at deploy time (wallet DUST balance drop across each deploy; under-states the fee because DUST keeps generating). Deploy cost, not attestation cost.', contracts };
}

/** Compiler / runtime / language versions as recorded by compactc in build/<name>/compiler/contract-info.json. */
export function compiledVersions(root: string, names: string[]) {
  return Object.fromEntries(names.map((n) => {
    const f = path.join(root, 'build', n, 'compiler', 'contract-info.json');
    if (!fs.existsSync(f)) return [n, null];
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return [n, { compiler: j['compiler-version'], compilerCommit: j['compiler-commit'], language: j['language-version'], runtime: j['runtime-version'] }];
  }));
}

export function packageVersion(root: string, pkg: string): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version; } catch { return null; }
}

/** Hardware of this host; recorded as the proof server's only when the proof server is local. */
export function hostHardware() {
  const cpus = os.cpus();
  return { cpuModel: cpus[0]?.model ?? null, cpuCount: cpus.length, memGiB: Math.round(os.totalmem() / 2 ** 30), arch: os.arch(), platform: `${os.platform()} ${os.release()}` };
}
export const isLocalUrl = (u: string) => { try { return ['127.0.0.1', 'localhost', '::1'].includes(new URL(u).hostname); } catch { return false; } };

export const benchFile = (root: string, network: string, date = new Date()) => path.join(root, 'benchmarks', `${network}-${date.toISOString().slice(0, 10)}.json`);

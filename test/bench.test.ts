/** scripts/lib/bench.ts — statistics, declared conversion, deploy baseline, versions (no network). */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile, summarize, makeConversion, convert, deployBaseline, compiledVersions, benchFile, isLocalUrl, type Sample } from '../scripts/lib/bench.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const s = (workload: string, i: number, ms: number, delta: string | null, est: string | null, ok = true): Sample => ({ workload, i, ok, ms, dustDelta: delta, feeEstimate: est });

describe('bench: statistics', () => {
  it('nearest-rank percentiles', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(xs, 50), 50);
    assert.equal(percentile(xs, 95), 100);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 50), null);
  });

  it('summary per workload: only successful runs count; non-positive balance deltas are dropped', () => {
    const r: any = summarize([
      s('attestCompliance', 0, 30_000, '1000', '1200'), s('attestCompliance', 1, 40_000, '-50', '1100'), s('attestCompliance', 2, 35_000, '900', null),
      s('attestCompliance', 3, 1_000, null, null, false), s('attestUseCase', 0, 20_000, '500', '600'),
    ]);
    assert.deepEqual(Object.keys(r).sort(), ['attestCompliance', 'attestUseCase']);
    const c = r.attestCompliance;
    assert.equal(c.runs, 4); assert.equal(c.ok, 3); assert.equal(c.failed, 1);
    assert.equal(c.latency_ms.p50, 35_000); assert.equal(c.latency_ms.p95, 40_000); assert.equal(c.latency_ms.min, 30_000);
    assert.equal(c.dust_per_tx_specks.balance_delta_samples, 2);
    assert.equal(c.dust_per_tx_specks.balance_delta_median, '900');
    assert.equal(c.dust_per_tx_specks.estimate_median, '1100');
  });
});

describe('bench: declared conversion', () => {
  it('DUST -> NIGHT held -> USD with the declared parameters', () => {
    const c = makeConversion({ nightUsd: '0.05', nightUsdSource: 'example', nightUsdDate: '2026-11-13' });
    assert.equal(c.dustPerNight, 5);
    assert.equal(c.specksPerDust, '1000000000000000');
    const v = convert('10000000000000000', c)!; // 10 DUST
    assert.equal(v.dust, 10); assert.equal(v.night_held_equivalent, 2); assert.equal(v.usd, 0.1);
    assert.match(c.basis, /not market data/);
  });

  it('no price without source and date; no price means usd null', () => {
    assert.throws(() => makeConversion({ nightUsd: '0.05' }), /source and date/);
    assert.throws(() => makeConversion({ nightUsd: '-1', nightUsdSource: 'x', nightUsdDate: '2026-11-13' }), /positive/);
    assert.throws(() => makeConversion({ nightUsd: '1', nightUsdSource: 'x', nightUsdDate: 'yesterday' }), /date/);
    const c = makeConversion({});
    assert.equal(c.nightUsd, null);
    assert.equal(convert('5000000000000000', c)!.usd, null);
    assert.equal(convert(null, c), null);
  });
});

describe('bench: baseline and metadata', () => {
  it('imports the preprod deploy dustSpent, marked as a deploy baseline', () => {
    const b: any = deployBaseline(path.join(ROOT, 'deployment-preprod-v9.json'), makeConversion({}));
    assert.equal(b.kind, 'deploy-baseline');
    assert.match(b.note, /Deploy cost, not attestation cost/);
    assert.ok(Object.keys(b.contracts).length >= 1);
    for (const v of Object.values<any>(b.contracts)) assert.match(v.dustSpent_specks, /^\d+$/);
    const missing: any = deployBaseline(path.join(os.tmpdir(), 'nope.json'), makeConversion({}));
    assert.equal(missing.note, 'file not found');
  });

  it('versions come from the compiled contracts; output path and local proof server detection', () => {
    const v: any = compiledVersions(ROOT, ['ComplianceRegistry', 'NoSuchContract']);
    assert.match(v.ComplianceRegistry.compiler, /^0\.36/);
    assert.equal(v.ComplianceRegistry.runtime, '0.21.0');
    assert.equal(v.NoSuchContract, null);
    assert.equal(path.relative(ROOT, benchFile(ROOT, 'preprod', new Date('2026-11-13T10:00:00Z'))), path.join('benchmarks', 'preprod-2026-11-13.json'));
    assert.equal(isLocalUrl('http://127.0.0.1:6300'), true);
    assert.equal(isLocalUrl('https://proof.example.net'), false);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'bench-attestation.ts')));
  });
});

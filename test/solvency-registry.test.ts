import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/SolvencyRegistry/contract/index.js';

const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
function setup() {
  const c = new Contract({});
  const cpk = '0'.repeat(64);
  const { currentContractState, currentPrivateState } = c.initialState({ initialZswapLocalState: { coinPublicKey: cpk } as any, initialPrivateState: {} } as any);
  return { c, ctx: createCircuitContext(dummyContractAddress(), cpk, currentContractState.data, currentPrivateState ?? {}) };
}
describe('SolvencyRegistry', () => {
  it('seals a solvent report: public verdict, amounts never written', () => {
    const { c, ctx } = setup();
    const r = c.circuits.sealSolvency(ctx, b32('entity'), b32('cid'), b32('ctx-1'), 20261106n, 1_000_000n, 800_000n);
    const L = ledger(r.context.currentQueryContext.state);
    assert.equal(L.solvency_verdicts.lookup(b32('entity')), 1n);
    assert.equal(L.solvency_count, 1n);
    assert.ok(!String(r.context.currentQueryContext.state).includes('0f4240'), 'reserves must not be in public state'); // 1_000_000 = 0x0f4240
  });
  it('rejects insolvent report and replayed context', () => {
    const { c, ctx } = setup();
    assert.throws(() => c.circuits.sealSolvency(ctx, b32('e'), b32('c'), b32('x'), 1n, 10n, 20n), /Insolvent/);
    const r = c.circuits.sealSolvency(ctx, b32('e'), b32('c'), b32('x'), 1n, 20n, 10n);
    assert.throws(() => c.circuits.sealSolvency(r.context, b32('e2'), b32('c'), b32('x'), 1n, 20n, 10n), /Replay/);
  });
});

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/SolvencyRegistry/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

const setup = () => setupOwned(Contract, pureCircuits);

describe('SolvencyRegistry', () => {
  it('seals a solvent report: public verdict, amounts never written', async () => {
    const { contract, ctx } = await setup();
    const r = await contract.circuits.sealSolvency(ctx, b32('entity'), b32('cid'), b32('ctx-1'), 20261106n, 1_000_000n, 800_000n);
    const state = r.context.callContext.currentQueryContext.state;
    const L = ledger(state);
    assert.equal(L.solvency_verdicts.lookup(b32('entity')), 1n);
    assert.equal(L.solvency_count, 1n);
    assert.ok(!String(state).includes('0f4240'), 'reserves must not be in public state'); // 1_000_000 = 0x0f4240
  });

  it('rejects insolvent report and replayed context', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.sealSolvency(ctx, b32('e'), b32('c'), b32('x'), 1n, 10n, 20n), /Insolvent/);
    const r = await contract.circuits.sealSolvency(ctx, b32('e'), b32('c'), b32('x'), 1n, 20n, 10n);
    await assert.rejects(() => contract.circuits.sealSolvency(r.context, b32('e2'), b32('c'), b32('x'), 1n, 20n, 10n), /Replay/);
  });

  it('rejects a seal from a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.sealSolvency(asStranger(ctx), b32('e'), b32('c'), b32('x'), 1n, 20n, 10n), NOT_OWNER);
  });
});

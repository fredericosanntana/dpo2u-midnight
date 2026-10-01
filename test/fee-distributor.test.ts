/**
 * FeeDistributor — 40/60 expert/auditor split (Counter pools).
 *
 * Rewritten for the consolidated contract: distributeComplianceFee(expert_share,
 * auditor_share) validates the 40/60 ratio on-chain (expert*3 == auditor*2).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/FeeDistributor/contract/index.js';

function setup() {
  const contract = new Contract({});
  const coinPublicKey = '0'.repeat(64) as unknown as string;
  const { currentContractState, currentPrivateState } = contract.initialState({
    initialZswapLocalState: { coinPublicKey },
    initialPrivateState: new Map(),
  });
  const ctx = createCircuitContext(
    dummyContractAddress(),
    coinPublicKey,
    currentContractState.data,
    currentPrivateState ?? new Map(),
  );
  return { contract, ctx };
}

describe('FeeDistributor (40/60 split)', () => {
  it('distributes a valid 40/60 split into expert/auditor pools', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.distributeComplianceFee(ctx, 400n, 600n);
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.expert_fee_pool, 400n);
    assert.equal(L.auditor_fee_pool, 600n);
    assert.equal(L.total_distributed, 1000n);
  });

  it('rejects a non-40/60 ratio', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.distributeComplianceFee(ctx, 500n, 600n),
      /Must be 40\/60 split/,
    );
  });

  it('rejects a zero expert share', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.distributeComplianceFee(ctx, 0n, 600n),
      /Expert share must be > 0/,
    );
  });

  it('reads pool balances back via getters', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.distributeComplianceFee(ctx, 200n, 300n);
    assert.equal(contract.circuits.getAuditorPool(context).result, 300n);
    const expert = contract.circuits.getExpertPool(context);
    assert.equal(expert.result, 200n);
    assert.equal(contract.circuits.getTotalDistributed(expert.context).result, 500n);
  });
});

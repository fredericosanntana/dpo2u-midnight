import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../compact/build/payment-gateway/contract/index.js';

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

describe('PaymentGateway', () => {
  it('should deposit to treasury', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.depositToTreasury(ctx, 1000n);

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.protocol_treasury, 1000n);
  });

  it('should reject deposit of 0', () => {
    const { contract, ctx } = setup();

    assert.throws(
      () => { contract.circuits.depositToTreasury(ctx, 0n); },
      /Deposit must be greater than zero/,
    );
  });

  it('should stake tokens', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.stakeTokens(ctx, 500n);

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.total_staked_night, 500n);
  });

  it('should reject stake of 0', () => {
    const { contract, ctx } = setup();

    assert.throws(
      () => { contract.circuits.stakeTokens(ctx, 0n); },
      /Stake must be greater than zero/,
    );
  });

  it('should return treasury balance', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.depositToTreasury(ctx, 750n);

    const balanceResult = contract.circuits.getTreasuryBalance(context);
    assert.equal(balanceResult.result, 750n);
  });
});

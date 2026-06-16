/**
 * PaymentGateway — treasury deposits + $NIGHT staking (Counter pools).
 * API unchanged from canonical; import path updated to the consolidated build layout.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/PaymentGateway/contract/index.js';

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
  it('deposits to treasury', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.depositToTreasury(ctx, 1000n);
    assert.equal(ledger(context.currentQueryContext.state).protocol_treasury, 1000n);
  });

  it('rejects a zero deposit', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.depositToTreasury(ctx, 0n), /Deposit must be greater than zero/);
  });

  it('stakes $NIGHT', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.stakeTokens(ctx, 500n);
    assert.equal(ledger(context.currentQueryContext.state).total_staked_night, 500n);
  });

  it('rejects a zero stake', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.stakeTokens(ctx, 0n), /Stake must be greater than zero/);
  });

  it('reads treasury balance back', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.depositToTreasury(ctx, 750n);
    assert.equal(contract.circuits.getTreasuryBalance(context).result, 750n);
  });
});

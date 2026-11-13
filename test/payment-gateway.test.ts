/**
 * PaymentGateway — treasury deposits + NIGHT deposit bookkeeping (Counter pools).
 * API unchanged from canonical; import path updated to the consolidated build layout.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/PaymentGateway/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function setup() {
  return setupOwned(Contract, pureCircuits);
}

describe('PaymentGateway', () => {
  it('deposits to treasury', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.depositToTreasury(ctx, 1000n);
    assert.equal(ledger(context.callContext.currentQueryContext.state).protocol_treasury, 1000n);
  });

  it('rejects a zero deposit', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.depositToTreasury(ctx, 0n), /Deposit must be greater than zero/);
  });

  it('books a NIGHT deposit', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.depositNight(ctx, 500n);
    assert.equal(ledger(context.callContext.currentQueryContext.state).total_night_deposited, 500n);
  });

  it('rejects a zero NIGHT deposit', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.depositNight(ctx, 0n), /NIGHT deposit must be greater than zero/);
  });

  it('reads treasury balance back', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.depositToTreasury(ctx, 750n);
    assert.equal((await contract.circuits.getTreasuryBalance(context)).result, 750n);
  });
});

describe('PaymentGateway access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.depositToTreasury(asStranger(ctx), 10n), NOT_OWNER);
  });
});

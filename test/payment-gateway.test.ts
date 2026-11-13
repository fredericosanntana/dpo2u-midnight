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

describe('PaymentGateway DUST delegation (hardening 2026-11-13)', () => {
  const H = b32('holder-1');
  it('delegator_count counts holders CURRENTLY delegating: register, update, revoke, re-register', async () => {
    const { contract, ctx } = await setup();
    const L = (c: any) => ledger(c.context.callContext.currentQueryContext.state);
    const r1 = await contract.circuits.registerDustDelegation(ctx, H, 1000n);
    assert.equal(L(r1).delegator_count, 1n);
    const r2 = await contract.circuits.registerDustDelegation(r1.context, H, 2000n);
    assert.equal(L(r2).delegator_count, 1n, 'an update of an active delegation does not count twice');
    assert.equal((await contract.circuits.getDelegatedNight(r2.context, H)).result, 2000n);
    const v = await contract.circuits.revokeDustDelegation(r2.context, H);
    assert.equal(L(v).delegator_count, 0n);
    assert.equal((await contract.circuits.getDelegatedNight(v.context, H)).result, 0n);
    await assert.rejects(() => contract.circuits.revokeDustDelegation(v.context, H), /No active delegation/);
    const r3 = await contract.circuits.registerDustDelegation(v.context, H, 500n);
    assert.equal(L(r3).delegator_count, 1n);
  });

  it('revoke of an unknown holder, a zero delegation and non-owner calls are refused', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.revokeDustDelegation(ctx, H), /No active delegation/);
    await assert.rejects(() => contract.circuits.registerDustDelegation(ctx, H, 0n), /greater than zero/);
    await assert.rejects(() => contract.circuits.registerDustDelegation(asStranger(ctx), H, 1n), NOT_OWNER);
    const r = await contract.circuits.registerDustDelegation(ctx, H, 1n);
    await assert.rejects(() => contract.circuits.revokeDustDelegation(asStranger(r.context), H), NOT_OWNER);
    await assert.rejects(() => contract.circuits.depositNight(asStranger(ctx), 1n), NOT_OWNER);
  });
});

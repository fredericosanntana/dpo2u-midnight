/**
 * DataAuditLog — LGPD Art. 37 processing audit trail (no data on-chain, only hashes + counters).
 * Event types 1-9; deletion/breach have dedicated counters (Art. 18 VI, Art. 48).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/DataAuditLog/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

const CONTROLLER = padTo32Bytes('did:controller:acme');
const ACTOR = padTo32Bytes('did:actor:system-01');

describe('DataAuditLog (LGPD Art. 37)', () => {
  it('logs a general event and updates per-controller + global counters', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.logEvent(ctx, CONTROLLER, 2n, 100n); // 2 = data_access
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.events_by_controller.lookup(CONTROLLER), 1n);
    assert.equal(L.last_event_type.lookup(CONTROLLER), 2n);
    assert.equal(L.last_event_block.lookup(CONTROLLER), 100n);
    assert.equal(L.event_count, 1n);
  });

  it('rejects an out-of-range event type', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.logEvent(ctx, CONTROLLER, 10n, 100n), /Unknown event type/);
  });

  it('rejects a zero block number', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.logEvent(ctx, CONTROLLER, 1n, 0n), /Block number required/);
  });

  it('tracks the deletion request → confirmation lifecycle (Art. 18 VI)', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.logDeletionRequest(ctx, CONTROLLER, ACTOR, 200n);
    const { context: c3 } = await contract.circuits.confirmDeletion(c2, CONTROLLER, ACTOR, 210n);
    const L = ledger(c3.callContext.currentQueryContext.state);
    assert.equal(L.deletion_requests, 1n);
    assert.equal(L.deletions_confirmed, 1n);
    assert.equal(L.last_event_type.lookup(CONTROLLER), 6n); // deletion_confirmed
  });

  it('logs a breach event into the dedicated counter (Art. 48)', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.logBreachEvent(ctx, CONTROLLER, 300n);
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.breach_events, 1n);
    assert.equal(L.last_event_type.lookup(CONTROLLER), 9n);
  });

  it('reads controller + total counters back', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.logEvent(ctx, CONTROLLER, 1n, 10n);
    const { context: c3 } = await contract.circuits.logEvent(c2, CONTROLLER, 3n, 20n);
    assert.equal((await contract.circuits.getControllerEventCount(c3, CONTROLLER)).result, 2n);
    assert.equal((await contract.circuits.getTotalEvents(c3)).result, 2n);
  });
});

describe('DataAuditLog access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.logEvent(asStranger(ctx), b32('controller'), 1n, 10n), NOT_OWNER);
  });
});

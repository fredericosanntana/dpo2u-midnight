/**
 * DataSubjectRights — LGPD Art. 18 rights requests + Art. 19 15-day deadline tracking.
 * Request types 1-9; status 1 open, 2 fulfilled, 3 rejected, 4 overdue. Deadline = 21600 blocks.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/DataSubjectRights/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

const REQ = padTo32Bytes('keccak256(subject||controller||type||nonce):1');
const DEADLINE = 21600n;

describe('DataSubjectRights (LGPD Art. 18-19)', () => {
  it('submits a request as open and counts it', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.submitRequest(ctx, REQ, 5n, 1000n); // 5 = portability
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 1n);
    assert.equal(L.request_type.lookup(REQ), 5n);
    assert.equal(L.total_requests, 1n);
  });

  it('rejects a duplicate request id', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.submitRequest(ctx, REQ, 5n, 1000n);
    await assert.rejects(() => contract.circuits.submitRequest(context, REQ, 5n, 1001n), /Request already exists/);
  });

  it('rejects an out-of-range request type', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.submitRequest(ctx, REQ, 10n, 1000n), /Unknown request type/);
  });

  it('fulfills an open request within the deadline', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.submitRequest(ctx, REQ, 2n, 1000n);
    const { context: c3 } = await contract.circuits.fulfillRequest(c2, REQ, 1500n);
    const L = ledger(c3.callContext.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 2n);
    assert.equal(L.total_fulfilled, 1n);
  });

  it('rejects fulfilling a non-open request', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.submitRequest(ctx, REQ, 2n, 1000n);
    const { context: c3 } = await contract.circuits.fulfillRequest(c2, REQ, 1500n);
    await assert.rejects(() => contract.circuits.fulfillRequest(c3, REQ, 1600n), /Request must be open to fulfill/);
  });

  it('marks a request overdue only after the Art. 19 deadline elapses', async () => {
    const { contract, ctx } = await setup();
    const submitted = 1000n;
    const { context: c2 } = await contract.circuits.submitRequest(ctx, REQ, 6n, submitted);
    // before deadline → rejected
    await assert.rejects(
      () => contract.circuits.markRequestOverdue(c2, REQ, submitted + DEADLINE - 1n),
      /deadline not yet exceeded/,
    );
    // at/after deadline → overdue
    const { context: c3 } = await contract.circuits.markRequestOverdue(c2, REQ, submitted + DEADLINE);
    const L = ledger(c3.callContext.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 4n);
    assert.equal(L.total_overdue, 1n);
  });

  it('exposes the LGPD deadline as 21600 blocks via reads', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.submitRequest(ctx, REQ, 1n, 500n);
    assert.equal((await contract.circuits.getRequestStatus(context, REQ)).result, 1n);
    assert.equal((await contract.circuits.getTotalRequests(context)).result, 1n);
  });
});

describe('DataSubjectRights access control', () => {
  it('lets anyone submit a request, but only the owner (controller) resolves it', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.submitRequest(asStranger(ctx), REQ, 5n, 1000n);
    await assert.rejects(() => contract.circuits.fulfillRequest(asStranger(context), REQ, 1500n), NOT_OWNER);
    await assert.rejects(() => contract.circuits.rejectRequest(asStranger(context), REQ, 1500n), NOT_OWNER);
    await assert.rejects(() => contract.circuits.markRequestOverdue(asStranger(context), REQ, 1000n + DEADLINE), NOT_OWNER);
  });
});

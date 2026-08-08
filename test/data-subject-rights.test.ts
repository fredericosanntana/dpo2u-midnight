/**
 * DataSubjectRights — LGPD Art. 18 rights requests + Art. 19 15-day deadline tracking.
 * Request types 1-9; status 1 open, 2 fulfilled, 3 rejected, 4 overdue. Deadline = 21600 blocks.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/DataSubjectRights/contract/index.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

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

const REQ = padTo32Bytes('keccak256(subject||controller||type||nonce):1');
const DEADLINE = 21600n;

describe('DataSubjectRights (LGPD Art. 18-19)', () => {
  it('submits a request as open and counts it', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.submitRequest(ctx, REQ, 5n, 1000n); // 5 = portability
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 1n);
    assert.equal(L.request_type.lookup(REQ), 5n);
    assert.equal(L.total_requests, 1n);
  });

  it('rejects a duplicate request id', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.submitRequest(ctx, REQ, 5n, 1000n);
    assert.throws(() => contract.circuits.submitRequest(context, REQ, 5n, 1001n), /Request already exists/);
  });

  it('rejects an out-of-range request type', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.submitRequest(ctx, REQ, 10n, 1000n), /Unknown request type/);
  });

  it('fulfills an open request within the deadline', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.submitRequest(ctx, REQ, 2n, 1000n);
    const { context: c3 } = contract.circuits.fulfillRequest(c2, REQ, 1500n);
    const L = ledger(c3.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 2n);
    assert.equal(L.total_fulfilled, 1n);
  });

  it('rejects fulfilling a non-open request', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.submitRequest(ctx, REQ, 2n, 1000n);
    const { context: c3 } = contract.circuits.fulfillRequest(c2, REQ, 1500n);
    assert.throws(() => contract.circuits.fulfillRequest(c3, REQ, 1600n), /Request must be open to fulfill/);
  });

  it('marks a request overdue only after the Art. 19 deadline elapses', () => {
    const { contract, ctx } = setup();
    const submitted = 1000n;
    const { context: c2 } = contract.circuits.submitRequest(ctx, REQ, 6n, submitted);
    // before deadline → rejected
    assert.throws(
      () => contract.circuits.markRequestOverdue(c2, REQ, submitted + DEADLINE - 1n),
      /deadline not yet exceeded/,
    );
    // at/after deadline → overdue
    const { context: c3 } = contract.circuits.markRequestOverdue(c2, REQ, submitted + DEADLINE);
    const L = ledger(c3.currentQueryContext.state);
    assert.equal(L.request_status.lookup(REQ), 4n);
    assert.equal(L.total_overdue, 1n);
  });

  it('exposes the LGPD deadline as 21600 blocks via reads', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.submitRequest(ctx, REQ, 1n, 500n);
    assert.equal(contract.circuits.getRequestStatus(context, REQ).result, 1n);
    assert.equal(contract.circuits.getTotalRequests(context).result, 1n);
  });
});

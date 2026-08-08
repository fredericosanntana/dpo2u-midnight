/**
 * AgentRegistry — DID + role registry (Map/role API).
 *
 * Rewritten for the consolidated contract (was a single-agent owner_secret_key model
 * with agent_active/registered_at/task_count). The new contract is a multi-agent
 * Map<did,status> + Map<did,role> registry.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/AgentRegistry/contract/index.js';

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

const DID = padTo32Bytes('did:midnight:agent:42');
const ROLE = padTo32Bytes('role:compliance-attestor');

describe('AgentRegistry (DID + role)', () => {
  it('registers an agent active with role and increments count', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.registerAgent(ctx, DID, ROLE);
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.agent_statuses.lookup(DID), 1n);
    assert.equal(L.agent_count, 1n);
  });

  it('isActive returns 1 for a registered agent', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.registerAgent(ctx, DID, ROLE);
    assert.equal(contract.circuits.isActive(context, DID).result, 1n);
  });

  it('deactivateAgent sets status to 0', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.registerAgent(ctx, DID, ROLE);
    const { context: c3 } = contract.circuits.deactivateAgent(c2, DID);
    assert.equal(ledger(c3.currentQueryContext.state).agent_statuses.lookup(DID), 0n);
  });

  it('rejects deactivating an unregistered agent', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.deactivateAgent(ctx, padTo32Bytes('did:unknown')),
      /Agent not registered/,
    );
  });

  it('counts multiple distinct agents', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.registerAgent(ctx, DID, ROLE);
    const { context: c3 } = contract.circuits.registerAgent(c2, padTo32Bytes('did:midnight:agent:43'), ROLE);
    assert.equal(contract.circuits.getAgentCount(c3).result, 2n);
  });
});

/**
 * AgentRegistry — DID + role registry (Map/role API).
 *
 * Rewritten for the consolidated contract (was a single-agent owner_secret_key model
 * with agent_active/registered_at/task_count). The new contract is a multi-agent
 * Map<did,status> + Map<did,role> registry.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/AgentRegistry/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

const DID = padTo32Bytes('did:midnight:agent:42');
const ROLE = padTo32Bytes('role:compliance-attestor');

describe('AgentRegistry (DID + role)', () => {
  it('registers an agent active with role and increments count', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.registerAgent(ctx, DID, ROLE);
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.agent_statuses.lookup(DID), 1n);
    assert.equal(L.agent_count, 1n);
  });

  it('isActive returns 1 for a registered agent', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.registerAgent(ctx, DID, ROLE);
    assert.equal((await contract.circuits.isActive(context, DID)).result, 1n);
  });

  it('deactivateAgent sets status to 0', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.registerAgent(ctx, DID, ROLE);
    const { context: c3 } = await contract.circuits.deactivateAgent(c2, DID);
    assert.equal(ledger(c3.callContext.currentQueryContext.state).agent_statuses.lookup(DID), 0n);
  });

  it('rejects deactivating an unregistered agent', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(
      () => contract.circuits.deactivateAgent(ctx, padTo32Bytes('did:unknown')),
      /Agent not registered/,
    );
  });

  it('counts multiple distinct agents', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.registerAgent(ctx, DID, ROLE);
    const { context: c3 } = await contract.circuits.registerAgent(c2, padTo32Bytes('did:midnight:agent:43'), ROLE);
    assert.equal((await contract.circuits.getAgentCount(c3)).result, 2n);
  });
});

describe('AgentRegistry access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.registerAgent(asStranger(ctx), b32('did:x'), b32('role')), NOT_OWNER);
  });
});

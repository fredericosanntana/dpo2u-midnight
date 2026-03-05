import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../compact/build/agent-registry/contract/index.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  const contract = new Contract({});
  const coinPublicKey = '0'.repeat(64);
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

describe('AgentRegistry', () => {
  it('should register an agent and update ledger state', () => {
    const { contract, ctx } = setup();
    const secretKey = padTo32Bytes('owner_secret_key_001');
    const did = padTo32Bytes('did:midnight:agent:42');

    const { context } = contract.circuits.registerAgent(ctx, secretKey, did, 100n);

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.agent_active, 1n);
    assert.equal(postLedger.registered_at, 100n);
    assert.equal(postLedger.task_count, 0n);
  });

  it('should reject deactivation with wrong key', () => {
    const { contract, ctx } = setup();
    const secretKey = padTo32Bytes('owner_secret_key_001');
    const wrongKey = padTo32Bytes('wrong_key_999');
    const did = padTo32Bytes('did:midnight:agent:42');

    const { context } = contract.circuits.registerAgent(ctx, secretKey, did, 100n);

    assert.throws(
      () => { contract.circuits.deactivateAgent(context, wrongKey); },
      /Only owner/,
    );
  });

  it('should deactivate agent with correct key', () => {
    const { contract, ctx } = setup();
    const secretKey = padTo32Bytes('owner_secret_key_001');
    const did = padTo32Bytes('did:midnight:agent:42');

    const { context: ctx2 } = contract.circuits.registerAgent(ctx, secretKey, did, 100n);
    const { context: ctx3 } = contract.circuits.deactivateAgent(ctx2, secretKey);

    const postLedger = ledger(ctx3.currentQueryContext.state);
    assert.equal(postLedger.agent_active, 0n);
  });

  it('should record tasks and increment task_count', () => {
    const { contract, ctx } = setup();
    const secretKey = padTo32Bytes('owner_secret_key_001');
    const did = padTo32Bytes('did:midnight:agent:42');

    const { context: ctx2 } = contract.circuits.registerAgent(ctx, secretKey, did, 50n);
    const { context: ctx3 } = contract.circuits.recordTask(ctx2, secretKey);
    const { context: ctx4 } = contract.circuits.recordTask(ctx3, secretKey);

    const postLedger = ledger(ctx4.currentQueryContext.state);
    assert.equal(postLedger.task_count, 2n);
  });

  it('should reject recordTask on inactive agent', () => {
    const { contract, ctx } = setup();
    const secretKey = padTo32Bytes('owner_secret_key_001');
    const did = padTo32Bytes('did:midnight:agent:42');

    const { context: ctx2 } = contract.circuits.registerAgent(ctx, secretKey, did, 50n);
    const { context: ctx3 } = contract.circuits.deactivateAgent(ctx2, secretKey);

    assert.throws(
      () => { contract.circuits.recordTask(ctx3, secretKey); },
      /Agent must be active/,
    );
  });
});

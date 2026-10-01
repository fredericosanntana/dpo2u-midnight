/**
 * AgentWalletFactory — DID → wallet-address registry for the self-funding agent economy.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/AgentWalletFactory/contract/index.js';

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
const WALLET = padTo32Bytes('mn_shield-addr_test1q...');

describe('AgentWalletFactory', () => {
  it('registers a wallet for an agent and increments count', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.registerAgent(ctx, DID, WALLET);
    assert.equal(ledger(context.currentQueryContext.state).wallet_count, 1n);
  });

  it('reads the wallet back for a DID', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.registerAgent(ctx, DID, WALLET);
    assert.deepEqual(contract.circuits.getAgentWallet(context, DID).result, WALLET);
  });

  it('counts multiple wallets', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.registerAgent(ctx, DID, WALLET);
    const { context: c3 } = contract.circuits.registerAgent(
      c2, padTo32Bytes('did:midnight:agent:43'), padTo32Bytes('mn_shield-addr_test1q...2'),
    );
    assert.equal(contract.circuits.getWalletCount(c3).result, 2n);
  });
});

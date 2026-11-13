/**
 * AgentWalletFactory — DID → wallet-address registry for the self-funding agent economy.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/AgentWalletFactory/contract/index.js';
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
const WALLET = padTo32Bytes('mn_shield-addr_test1q...');

describe('AgentWalletFactory', () => {
  it('registers a wallet for an agent and increments count', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.registerAgent(ctx, DID, WALLET);
    assert.equal(ledger(context.callContext.currentQueryContext.state).wallet_count, 1n);
  });

  it('reads the wallet back for a DID', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.registerAgent(ctx, DID, WALLET);
    assert.deepEqual((await contract.circuits.getAgentWallet(context, DID)).result, WALLET);
  });

  it('counts multiple wallets', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.registerAgent(ctx, DID, WALLET);
    const { context: c3 } = await contract.circuits.registerAgent(
      c2, padTo32Bytes('did:midnight:agent:43'), padTo32Bytes('mn_shield-addr_test1q...2'),
    );
    assert.equal((await contract.circuits.getWalletCount(c3)).result, 2n);
  });
});

describe('AgentWalletFactory access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.registerAgent(asStranger(ctx), b32('did:x'), b32('wallet')), NOT_OWNER);
  });
});

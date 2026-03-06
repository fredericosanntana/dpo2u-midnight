import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../compact/build/fee-distributor/contract/index.js';

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

describe('FeeDistributor', () => {
  it('should distribute fees with valid 40/60 split', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.distributeComplianceFee(
      ctx,
      padTo32Bytes('company_001'),
      padTo32Bytes('did:expert:01'),
      padTo32Bytes('did:auditor:01'),
      1000n, 400n, 600n,
    );

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.expert_fee_pool, 400n);
    assert.equal(postLedger.auditor_fee_pool, 600n);
  });

  it('should reject fee = 0', () => {
    const { contract, ctx } = setup();

    assert.throws(
      () => {
        contract.circuits.distributeComplianceFee(
          ctx,
          padTo32Bytes('company'),
          padTo32Bytes('expert'),
          padTo32Bytes('auditor'),
          0n, 0n, 0n,
        );
      },
      /Fee must be greater than zero/,
    );
  });

  it('should reject mismatched shares', () => {
    const { contract, ctx } = setup();

    assert.throws(
      () => {
        contract.circuits.distributeComplianceFee(
          ctx,
          padTo32Bytes('company'),
          padTo32Bytes('expert'),
          padTo32Bytes('auditor'),
          1000n, 500n, 600n,
        );
      },
      /Shares must sum to total amount/,
    );
  });

  it('should query pool balances', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.distributeComplianceFee(
      ctx,
      padTo32Bytes('company'),
      padTo32Bytes('expert'),
      padTo32Bytes('auditor'),
      500n, 200n, 300n,
    );

    const auditorResult = contract.circuits.getAuditorPools(context);
    assert.equal(auditorResult.result, 300n);

    const expertResult = contract.circuits.getExpertPools(auditorResult.context);
    assert.equal(expertResult.result, 200n);
  });
});

import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  distributeComplianceFee(context: __compactRuntime.CircuitContext<PS>,
                          company_id_0: Uint8Array,
                          expert_agent_did_0: Uint8Array,
                          auditor_agent_did_0: Uint8Array,
                          total_amount_0: bigint,
                          expert_share_0: bigint,
                          auditor_share_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  getAuditorPools(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getExpertPools(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  distributeComplianceFee(context: __compactRuntime.CircuitContext<PS>,
                          company_id_0: Uint8Array,
                          expert_agent_did_0: Uint8Array,
                          auditor_agent_did_0: Uint8Array,
                          total_amount_0: bigint,
                          expert_share_0: bigint,
                          auditor_share_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  getAuditorPools(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getExpertPools(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  readonly expert_fee_pool: bigint;
  readonly auditor_fee_pool: bigint;
  company_expert_fees: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  company_auditor_fees: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;

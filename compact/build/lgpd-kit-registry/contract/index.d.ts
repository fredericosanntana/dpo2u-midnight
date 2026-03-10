import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  registerLgpdKit(context: __compactRuntime.CircuitContext<PS>,
                  company_id_0: Uint8Array,
                  dpia_hash_0: Uint8Array,
                  policy_hash_0: Uint8Array,
                  score_0: bigint,
                  auditor_did_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  getCompanyPrivacyScore(context: __compactRuntime.CircuitContext<PS>,
                         company_id_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  registerLgpdKit(context: __compactRuntime.CircuitContext<PS>,
                  company_id_0: Uint8Array,
                  dpia_hash_0: Uint8Array,
                  policy_hash_0: Uint8Array,
                  score_0: bigint,
                  auditor_did_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  getCompanyPrivacyScore(context: __compactRuntime.CircuitContext<PS>,
                         company_id_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  kit_dpia_hashes: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  kit_policy_hashes: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  kit_privacy_scores: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  kit_auditor_dids: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
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

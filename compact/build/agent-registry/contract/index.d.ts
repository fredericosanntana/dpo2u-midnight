import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  registerAgent(context: __compactRuntime.CircuitContext<PS>,
                secret_key_0: Uint8Array,
                did_0: Uint8Array,
                block_height_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deactivateAgent(context: __compactRuntime.CircuitContext<PS>,
                  secret_key_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  recordTask(context: __compactRuntime.CircuitContext<PS>,
             secret_key_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  verifyAgent(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  registerAgent(context: __compactRuntime.CircuitContext<PS>,
                secret_key_0: Uint8Array,
                did_0: Uint8Array,
                block_height_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deactivateAgent(context: __compactRuntime.CircuitContext<PS>,
                  secret_key_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  recordTask(context: __compactRuntime.CircuitContext<PS>,
             secret_key_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  verifyAgent(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  readonly agent_owner_hash: Uint8Array;
  readonly agent_did: Uint8Array;
  readonly agent_active: bigint;
  readonly registered_at: bigint;
  readonly task_count: bigint;
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

import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  depositToTreasury(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  stakeTokens(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdrawFromTreasury(context: __compactRuntime.CircuitContext<PS>,
                       amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  unstakeTokens(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  getTreasuryBalance(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getStakedBalance(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  depositToTreasury(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  stakeTokens(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdrawFromTreasury(context: __compactRuntime.CircuitContext<PS>,
                       amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  unstakeTokens(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  getTreasuryBalance(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getStakedBalance(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
}

export type Ledger = {
  readonly protocol_treasury: bigint;
  readonly total_staked_night: bigint;
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

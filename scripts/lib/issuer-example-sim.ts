/**
 * ShieldedDepositIssuer in the simulator, linked to a simulated PsavPassport (no network, no funds).
 * Shared by test/issuer-example.test.ts and scripts/demo-issuer.ts. Needs `bash scripts/compile.sh`.
 */
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import * as Issuer from '../../build/ShieldedDepositIssuer/contract/index.js';
import * as Passport from '../../build/PsavPassport/contract/index.js';
import { simAddress, contractRef, asDeployed, crossContract, SIM_BLOCK_HASH } from './sim-cross-contract.js';
import { issuerWitnesses, newPS, type IssuerPS } from './issuer-example.js';

export { Issuer, Passport };
/** Dummy coin public key and a fixed block time (unix s) so expiry tests are deterministic. */
export const CPK = '0'.repeat(64);
export const T0 = 1_800_000_000;
export const ISSUER_ADDR = simAddress(0x155e);
export const PASSPORT_ADDR = simAddress(0x9a55);

/** Label -> 32 bytes, zero-padded (truncated past 32 bytes). Test and demo ids only. */
export const b32 = (s: string): Uint8Array => {
  const x = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(x, 0, 0, Math.min(Buffer.byteLength(s), 32));
  return new Uint8Array(x);
};

/** Passports in the simulated PsavPassport: P_OK and P_OK2 tier 0 machine-only PASS (valid); P_REVIEW tier 1 without reviewer (REVIEW, not valid). */
export const P_OK = b32('passport:psav-a (fictitious)');
export const P_REVIEW = b32('passport:psav-b (fictitious)');
export const P_OK2 = b32('passport:psav-c (fictitious)');

export const witnesses = issuerWitnesses(Issuer.pureCircuits);
export const pure = Issuer.pureCircuits;

async function passportChain() {
  const iss = b32('passport-issuer');
  const pw: any = {
    owner_secret: (x: any) => [x.privateState, iss],
    rule_origins: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]],
    rule_verdicts: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]],
    partner_id: (x: any) => [x.privateState, b32('p')], commit_salt: (x: any) => [x.privateState, b32('s')],
    reviewer_sig_hash: (x: any) => [x.privateState, new Uint8Array(32)], evidence_hash: (x: any) => [x.privateState, b32('e')],
    sponsor_secret: (x: any) => [x.privateState, b32('x')],
  };
  const p = new Passport.Contract(pw);
  const init = (await p.initialState(createConstructorContext({}, CPK), Passport.pureCircuits.owner_commitment(iss))).currentContractState;
  const step = async (state: any, circuit: string, ...args: unknown[]) => (await (p.circuits as any)[circuit](createCircuitContext({
    circuitId: circuit, contractAddress: PASSPORT_ADDR, coinPublicKeyOrZswapState: CPK, contractState: state, privateState: {}, time: T0,
  } as any), ...args)).context.callContext.currentQueryContext.state;
  let s = await step(init.data, 'issuePassport', P_OK, b32('pack'), b32('1.0.0'), 0n, BigInt(T0 - 60), BigInt(T0 - 60 + 31_536_000));
  s = await step(s, 'issuePassport', P_REVIEW, b32('pack'), b32('1.0.0'), 1n, BigInt(T0 - 60), BigInt(T0 - 60 + 31_536_000));
  s = await step(s, 'issuePassport', P_OK2, b32('pack'), b32('1.0.0'), 0n, BigInt(T0 - 60), BigInt(T0 - 60 + 31_536_000));
  return { init, state: s, step };
}

export type Sim = Awaited<ReturnType<typeof simulateIssuer>>;

/** Deploys the issuer (owner = ownerSecret) in the simulator, linked to the simulated passport contract. */
export async function simulateIssuer(ownerSecret: Uint8Array, assetId: Uint8Array, w: Issuer.Witnesses<IssuerPS> = witnesses) {
  const C = new Issuer.Contract<IssuerPS>(w);
  const pc = await passportChain();
  let cross = crossContract({ [PASSPORT_ADDR]: { state: asDeployed(pc.init, pc.state, 'PsavPassport'), module: Passport } });
  const { currentContractState } = await C.initialState(createConstructorContext(newPS(), CPK), pure.owner_commitment(ownerSecret), assetId, contractRef(PASSPORT_ADDR));
  const sim = {
    state: currentContractState.data as any,
    /** Runs a circuit as the party holding `ps`; on success the ledger state advances. `contract` swaps in other witnesses (forgery tests). */
    async call(circuit: string, ps: IssuerPS, args: unknown[], time = T0, contract: any = C): Promise<any> {
      const r = await contract.circuits[circuit](createCircuitContext({
        circuitId: circuit, contractAddress: ISSUER_ADDR, coinPublicKeyOrZswapState: CPK, contractState: sim.state,
        privateState: ps, time, parentBlockHash: SIM_BLOCK_HASH, crossContract: cross,
      } as any), ...args);
      sim.state = r.context.callContext.currentQueryContext.state;
      return r.result;
    },
    get L() { return Issuer.ledger(sim.state); },
    /** Suspends a passport in the linked contract (what its issuer would do on chain). */
    async suspendPassport(id: Uint8Array) {
      pc.state = await pc.step(pc.state, 'suspendPassport', id);
      cross = crossContract({ [PASSPORT_ADDR]: { state: asDeployed(pc.init, pc.state, 'PsavPassport'), module: Passport } });
    },
  };
  return sim;
}

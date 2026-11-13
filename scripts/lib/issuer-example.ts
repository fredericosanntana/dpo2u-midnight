/**
 * scripts/lib/issuer-example.ts — the network-free side of compact/examples/ShieldedDepositIssuer.compact:
 * the witnesses (fed from a private state), the off-chain balance book (one opening per account),
 * and the --plan output used by scripts/demo-issuer.ts. Shared with test/issuer-example.test.ts.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, Witnesses } from '../../build/ShieldedDepositIssuer/contract/index.js';

export const ISSUER = 'ShieldedDepositIssuer';
export const PASSPORT = 'PsavPassport';

export type Opening = { balance: bigint; salt: Uint8Array };
export type CredentialIn = { credential_hash: Uint8Array; salt: Uint8Array };

/**
 * Private state of one party (issuer, holder or auditor). Only the fields that party holds are set.
 * `book` is the off-chain balance book the issuer and the holder share: account hex -> opening.
 * `pending` is the salt the last circuit drew for an account, kept until settle() confirms it.
 */
export type IssuerPS = {
  ownerSecret?: Uint8Array;
  holderSecret?: Uint8Array;
  auditorSecret?: Uint8Array;
  credential?: CredentialIn;
  book: Map<string, Opening>;
  pending: Map<string, Uint8Array>;
  /** TESTS ONLY: deterministic salts. Unset in real use (salts then come from randomBytes). */
  saltSource?: () => Uint8Array;
};

export const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

export function newPS(p: Partial<IssuerPS> = {}): IssuerPS {
  return { book: new Map(), pending: new Map(), ...p };
}

const need = (v: Uint8Array | undefined, what: string): Uint8Array => {
  if (!v) throw new Error(`${what} is not held by this party`);
  return v;
};

type Ctx = WitnessContext<Ledger, IssuerPS>;

/**
 * Witnesses for ShieldedDepositIssuer, checked against the generated Witnesses type.
 * `pure` is the contract's pureCircuits: an account missing from the book is opened at its public
 * zero commitment (zero_balance_salt). A party lacking a secret throws (the call fails off chain).
 *
 * next_salt records the salt it drew in ps.pending, in place: the caller's IssuerPS object is the
 * party's wallet, and settle() later moves that salt into the book once the new commitment is on the
 * ledger (and refuses if it does not open it). If a call is re-run, the last salt drawn wins; settle()
 * catches any mismatch. Persist the book in real use: losing an opening locks the account's proofs.
 */
export function issuerWitnesses(pure: { zero_balance_salt(id: Uint8Array): Uint8Array }): Witnesses<IssuerPS> {
  return {
    owner_secret: (c: Ctx): [IssuerPS, Uint8Array] => [c.privateState, need(c.privateState.ownerSecret, 'owner secret')],
    holder_secret: (c: Ctx): [IssuerPS, Uint8Array] => [c.privateState, need(c.privateState.holderSecret, 'holder secret')],
    auditor_secret: (c: Ctx): [IssuerPS, Uint8Array] => [c.privateState, need(c.privateState.auditorSecret, 'auditor secret')],
    credential: (c: Ctx): [IssuerPS, CredentialIn] => {
      const cr = c.privateState.credential;
      if (!cr) throw new Error('credential is not held by this party');
      return [c.privateState, cr];
    },
    // The path comes from the PUBLIC tree (anyone can rebuild it); the contract binds it to the leaf.
    credential_path: (c: Ctx, leaf: Uint8Array) => {
      const p = c.ledger.credentials.findPathForLeaf(leaf);
      if (!p) throw new Error('credential leaf not in the attested tree');
      return [c.privateState, p];
    },
    balance_opening: (c: Ctx, id: Uint8Array): [IssuerPS, Opening] => {
      const o = c.privateState.book.get(hex(id)) ?? { balance: 0n, salt: pure.zero_balance_salt(id) };
      return [c.privateState, o];
    },
    next_salt: (c: Ctx, id: Uint8Array): [IssuerPS, Uint8Array] => {
      const ps = c.privateState;
      const s = ps.saltSource ? ps.saltSource() : new Uint8Array(randomBytes(32));
      ps.pending.set(hex(id), s);
      return [ps, s];
    },
  };
}

/**
 * After a successful issue/redeem: records the new opening, but only if it really opens the
 * commitment now on the ledger (so a wrong expected balance is caught here, not at the next call).
 */
export function settle(ps: IssuerPS, pure: { balance_commitment(b: bigint, s: Uint8Array): Uint8Array }, onChain: Uint8Array, id: Uint8Array, balance: bigint): void {
  const s = ps.pending.get(hex(id));
  if (!s) throw new Error('no pending salt for this account');
  if (hex(pure.balance_commitment(balance, s)) !== hex(onChain)) throw new Error('expected balance does not open the on-chain commitment');
  ps.book.set(hex(id), { balance, salt: s });
  ps.pending.delete(hex(id));
}

/** Copies the openings of one account into another party's book (issuer -> holder hand-off, off chain). */
export function shareOpening(from: IssuerPS, to: IssuerPS, id: Uint8Array): void {
  const o = from.book.get(hex(id));
  if (o) to.book.set(hex(id), { balance: o.balance, salt: new Uint8Array(o.salt) });
}

// ── --plan ──

export const COMMANDS = [
  'attest-credential', 'enroll-psav', 'enroll-credential', 'issue', 'redeem', 'freeze', 'unfreeze',
  'register-auditor', 'revoke-auditor', 'request-check', 'answer-check', 'status',
] as const;
export type Command = (typeof COMMANDS)[number];

type Spec = { circuit: string | null; key: string; cross: boolean; publicArgs: string[]; privateInputs: string[]; publishes: string };
const SPEC: Record<Command, Spec> = {
  'attest-credential': { circuit: 'attestCredential', key: 'issuer (owner_secret)', cross: false, publicArgs: ['leaf (hashed again by the tree)'], privateInputs: [], publishes: 'a new leaf hash in credentials' },
  'enroll-psav': { circuit: 'enrollPsav', key: 'issuer (owner_secret)', cross: true, publicArgs: ['account_id', 'passport_id', 'holder_commit'], privateInputs: [], publishes: 'account kind 1, holder commitment, passport binding, zero balance commitment' },
  'enroll-credential': { circuit: 'enrollWithCredential', key: 'holder (holder_secret + credential opening)', cross: false, publicArgs: ['account_id'], privateInputs: ['holder_secret', 'credential_hash', 'salt', 'Merkle path'], publishes: 'account kind 2, nullifier, holder commitment, zero balance commitment' },
  issue: { circuit: 'issue', key: 'issuer (owner_secret)', cross: true, publicArgs: ['account_id'], privateInputs: ['amount', 'balance opening', 'new salt'], publishes: 'a new balance commitment (amount hidden)' },
  redeem: { circuit: 'redeem', key: 'holder (holder_secret)', cross: false, publicArgs: ['account_id'], privateInputs: ['amount', 'balance opening', 'new salt'], publishes: 'a new balance commitment (amount hidden)' },
  freeze: { circuit: 'freeze', key: 'issuer (owner_secret)', cross: false, publicArgs: ['account_id'], privateInputs: ['reason_hash', 'salt'], publishes: 'frozen flag + salted reason commitment' },
  unfreeze: { circuit: 'unfreeze', key: 'issuer (owner_secret)', cross: false, publicArgs: ['account_id'], privateInputs: ['reason_hash', 'salt'], publishes: 'frozen flag cleared + salted reason commitment' },
  'register-auditor': { circuit: 'registerAuditor', key: 'issuer (owner_secret)', cross: false, publicArgs: ['auditor_id', 'key_commit', 'scope', 'expires_at', 'budget'], privateInputs: [], publishes: 'auditor key commitment, scope, expiry, check budget' },
  'revoke-auditor': { circuit: 'revokeAuditor', key: 'issuer (owner_secret)', cross: false, publicArgs: ['auditor_id'], privateInputs: [], publishes: 'auditor revoked' },
  'request-check': { circuit: 'requestCheck', key: 'auditor (auditor_secret)', cross: false, publicArgs: ['check_id', 'auditor_id', 'account_id', 'rule', 'limit'], privateInputs: [], publishes: 'check request (status 1) + snapshot of the balance commitment; one unit of the auditor budget spent' },
  'answer-check': { circuit: 'answerCheck', key: 'issuer (owner_secret)', cross: false, publicArgs: ['check_id'], privateInputs: ['balance opening'], publishes: 'HOLDS (2) or VIOLATED (3), nothing else; refused if the balance moved since the request' },
  status: { circuit: null, key: 'none (indexer read)', cross: false, publicArgs: ['account_id'], privateInputs: [], publishes: 'nothing' },
};

/** What a command would run, with no wallet and no network. Only the public args are echoed. */
export function plan(root: string, network: string, cmd: Command, args: Record<string, unknown>) {
  const s = SPEC[cmd];
  if (!s) throw new Error(`unknown command ${cmd}; one of ${COMMANDS.join(', ')}`);
  const rel = (n: string) => path.relative(root, path.join(root, 'build', n));
  return {
    network, contract: ISSUER, command: cmd, circuit: s.circuit, key: s.key,
    crossContract: s.cross ? `${PASSPORT}.isValid(passport_id)` : null,
    zkSources: s.circuit ? (s.cross ? [rel(ISSUER), rel(PASSPORT)] : [rel(ISSUER)]) : [],
    publicArgs: s.publicArgs, privateInputs: s.privateInputs, publishes: s.publishes,
    transaction: s.circuit !== null && network !== 'simulator',
    args: Object.fromEntries(Object.entries(args).filter(([k]) => s.publicArgs.some((p) => p.split(' ')[0] === k))),
  };
}

/**
 * Signed sanctions-list snapshots for TravelRuleGate.evaluateTransfer (witness sanctions_list).
 *
 * The provider (screening vendor or the VASP's list service) holds a Jubjub Schnorr key. For each
 * list snapshot it signs, with compact-runtime's jubjubSchnorrSign, the message
 *   TravelRuleGate.sanctions_message(list_root, provider_id, issued_at, valid_until)
 *   = [transientHash<Bytes<32>>(list_root), transientHash<Bytes<32>>(provider_id), issued_at, valid_until]
 * (a Vector<4, Field>). The gate owner registers the provider's public key on chain
 * (registerSanctionsProvider); the circuit checks the signature, the key, revocation and that the
 * block time is before valid_until, and records root / provider / valid_until in the verdict.
 *
 * Payload (JSON) the gateway passes to the operator for evaluateTransfer — all hex lowercase, 32 bytes:
 *   {
 *     "provider_id": "<hex32>",        // id the provider is registered under (e.g. sha256 of its name)
 *     "list_root":   "<hex32>",        // sanctionsListRoot(entries) of the snapshot screened against
 *     "issued_at":   1800000000,       // unix seconds
 *     "valid_until": 1800086400,       // unix seconds, > issued_at
 *     "signature": { "announcement": { "x": "<decimal>", "y": "<decimal>" }, "response": "<decimal>" }
 *   }
 * Jubjub coordinates and the response are field elements, written as decimal strings.
 */
import { createHash } from 'node:crypto';
import {
  CompactTypeField, CompactTypeVector, jubjubSchnorrSign, jubjubSchnorrVerifyingKey, sampleJubjubSchnorrSk,
  type JubjubPoint, type JubjubSchnorrSignature,
} from '@midnight-ntwrk/compact-runtime';

export type SanctionsListWitness = { provider_id: Uint8Array; list_root: Uint8Array; issued_at: bigint; valid_until: bigint; signature: JubjubSchnorrSignature };
export type SanctionsListPayload = {
  provider_id: string; list_root: string; issued_at: number; valid_until: number;
  signature: { announcement: { x: string; y: string }; response: string };
};
type GateModule = { pureCircuits: { sanctions_message(root: Uint8Array, id: Uint8Array, issued: bigint, until: bigint): bigint[] } };

const HEX32 = /^[0-9a-f]{64}$/;
const DEC = /^\d+$/;
const MSG_TYPE = new CompactTypeVector(4, CompactTypeField);

/** Root of a list snapshot: sha256 over the sorted, de-duplicated entry hashes (hex). */
export function sanctionsListRoot(entryHashesHex: string[]): Uint8Array {
  const xs = [...new Set(entryHashesHex.map((h) => h.toLowerCase()))].sort();
  for (const h of xs) if (!HEX32.test(h)) throw new Error('list entries must be sha256 hex hashes');
  return new Uint8Array(createHash('sha256').update('dpo2u/sanctions-list/v1').update(Buffer.from(xs.join(''), 'hex')).digest());
}

export const newProviderKey = () => { const sk = sampleJubjubSchnorrSk(); return { sk, pk: jubjubSchnorrVerifyingKey(sk) }; };
export const providerPublicKey = (sk: bigint): JubjubPoint => jubjubSchnorrVerifyingKey(sk);

/** Provider side: signs one snapshot with the same message the circuit verifies. */
export function signSanctionsList(gate: GateModule, sk: bigint, l: { provider_id: Uint8Array; list_root: Uint8Array; issued_at: bigint; valid_until: bigint }): SanctionsListWitness {
  if (l.valid_until <= l.issued_at) throw new Error('valid_until must be after issued_at');
  const msg = gate.pureCircuits.sanctions_message(l.list_root, l.provider_id, l.issued_at, l.valid_until);
  return { ...l, signature: jubjubSchnorrSign(MSG_TYPE, msg, sk) };
}

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

export function toPayload(w: SanctionsListWitness): SanctionsListPayload {
  return {
    provider_id: hex(w.provider_id), list_root: hex(w.list_root), issued_at: Number(w.issued_at), valid_until: Number(w.valid_until),
    signature: { announcement: { x: w.signature.announcement.x.toString(), y: w.signature.announcement.y.toString() }, response: w.signature.response.toString() },
  };
}

/** Gateway payload -> witness value; refuses missing or malformed fields (no defaults). */
export function fromPayload(p: any): SanctionsListWitness {
  const miss = ['provider_id', 'list_root', 'issued_at', 'valid_until', 'signature'].filter((k) => p?.[k] === undefined || p?.[k] === null);
  if (miss.length) throw new Error(`sanctions list payload missing: ${miss.join(', ')}`);
  if (!HEX32.test(p.provider_id) || !HEX32.test(p.list_root)) throw new Error('provider_id and list_root must be 32 bytes of lowercase hex');
  if (!Number.isSafeInteger(p.issued_at) || !Number.isSafeInteger(p.valid_until) || p.valid_until <= p.issued_at) throw new Error('issued_at / valid_until must be unix seconds with valid_until > issued_at');
  const s = p.signature;
  if (!DEC.test(String(s?.announcement?.x)) || !DEC.test(String(s?.announcement?.y)) || !DEC.test(String(s?.response))) throw new Error('signature must be { announcement: { x, y }, response } as decimal strings');
  return {
    provider_id: new Uint8Array(Buffer.from(p.provider_id, 'hex')), list_root: new Uint8Array(Buffer.from(p.list_root, 'hex')),
    issued_at: BigInt(p.issued_at), valid_until: BigInt(p.valid_until),
    signature: { announcement: { x: BigInt(s.announcement.x), y: BigInt(s.announcement.y) }, response: BigInt(s.response) },
  };
}

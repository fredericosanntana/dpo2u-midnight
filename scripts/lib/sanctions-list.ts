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
 *     "list_root":   "<hex32>",        // sanctionsListRoot(entries): indexed-tree root of the snapshot
 *     "issued_at":   1800000000,       // unix seconds
 *     "valid_until": 1800086400,       // unix seconds, > issued_at
 *     "signature": { "announcement": { "x": "<decimal>", "y": "<decimal>" }, "response": "<decimal>" }
 *   }
 * Jubjub coordinates and the response are field elements, written as decimal strings.
 *
 * Since v11 the gate proves each party's identifiers against the list in-circuit (witness
 * sanctions_path): list_root is the root of an indexed Merkle tree (SanctionsTree below), and the
 * operator needs the snapshot's entries (public, one sha256 hex per line) to build the paths.
 */
import {
  CompactTypeField, CompactTypeVector, transientHash, jubjubSchnorrSign, jubjubSchnorrVerifyingKey, sampleJubjubSchnorrSk,
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

// ── indexed (sorted) Merkle tree over screening keys: same hashing as TravelRuleGate ──
// Leaves (value, next) in key order: leaf 0 = (0, k1), then (k1, k2) ... (kn, 0); next 0 = none.
// Empty slots hash to 0 (no preimage), so they can never be opened as a leaf.
export const SANCTIONS_TREE_DEPTH = 20;
const V3 = new CompactTypeVector(3, CompactTypeField);
export const leafHash = (value: bigint, next: bigint): bigint => transientHash(V3, [1n, value, next]);
export const nodeHash = (l: bigint, r: bigint): bigint => transientHash(V3, [2n, l, r]);
/** Field -> the 32 bytes the provider signs (little-endian, as the circuit's Field-as-Bytes<32> cast). */
export function rootBytes(root: bigint): Uint8Array {
  const out = new Uint8Array(32); let v = root;
  for (let i = 0; i < 32; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
/** Screening key of an identifier hash: first 16 bytes, big-endian (TravelRuleGate.screening_key). */
export function screeningKey(h: Uint8Array | string): bigint {
  const b = typeof h === 'string' ? Buffer.from(h, 'hex') : Buffer.from(h);
  if (b.length !== 32) throw new Error('screening key needs a 32-byte hash');
  return BigInt('0x' + b.subarray(0, 16).toString('hex'));
}
export type SanctionsPath = { leaf: { value: bigint; next: bigint }; steps: { sibling: bigint; is_right: boolean }[] };

export class SanctionsTree {
  readonly keys: bigint[];
  private readonly levels: bigint[][];   // levels[0] = leaf hashes (occupied prefix only)
  private readonly zeros: bigint[];      // hash of an empty subtree at each level
  constructor(entryHashesHex: string[], readonly depth = SANCTIONS_TREE_DEPTH) {
    for (const h of entryHashesHex) if (!HEX32.test(h.toLowerCase())) throw new Error('list entries must be sha256 hex hashes');
    this.keys = [...new Set(entryHashesHex.map((h) => screeningKey(h.toLowerCase())))].filter((k) => k !== 0n).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (this.keys.length + 1 > 2 ** depth) throw new Error(`list too large for a depth-${depth} tree`);
    const vals = [0n, ...this.keys];
    this.levels = [vals.map((v, i) => leafHash(v, vals[i + 1] ?? 0n))];
    this.zeros = [0n];
    for (let d = 0; d < depth; d++) {
      const cur = this.levels[d], z = this.zeros[d], up: bigint[] = [];
      for (let i = 0; i < cur.length; i += 2) up.push(nodeHash(cur[i], cur[i + 1] ?? z));
      this.levels.push(up);
      this.zeros.push(nodeHash(z, z));
    }
  }
  get root(): bigint { return this.levels[this.depth][0]; }
  get rootBytes(): Uint8Array { return rootBytes(this.root); }
  /** The leaf with value <= key < next and its siblings (the witness sanctions_path(key)). */
  path(key: bigint): SanctionsPath {
    let lo = 0, hi = this.keys.length;            // index of the last listed key <= key, +1
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.keys[m] <= key) lo = m + 1; else hi = m; }
    let idx = lo;                                  // leaf index: 0 is the (0, k1) sentinel
    const value = idx === 0 ? 0n : this.keys[idx - 1], next = this.keys[idx] ?? 0n;
    const steps: SanctionsPath['steps'] = [];
    for (let d = 0; d < this.depth; d++) {
      const sib = idx ^ 1;
      steps.push({ sibling: this.levels[d][sib] ?? this.zeros[d], is_right: (idx & 1) === 1 });
      idx >>= 1;
    }
    return { leaf: { value, next }, steps };
  }
  has(key: bigint): boolean { const p = this.path(key); return key !== 0n && p.leaf.value === key; }
}
/** Recomputes the root from a path, as the circuit does (sanctions_path_root). */
export function pathRoot(p: SanctionsPath): bigint {
  return p.steps.reduce((acc, s) => (s.is_right ? nodeHash(s.sibling, acc) : nodeHash(acc, s.sibling)), leafHash(p.leaf.value, p.leaf.next));
}

/** Root of a list snapshot (the list_root the provider signs): indexed-tree root over the entry hashes. */
export function sanctionsListRoot(entryHashesHex: string[]): Uint8Array {
  return new SanctionsTree(entryHashesHex).rootBytes;
}

/** Reads a snapshot's entries (one sha256 hex per line) and checks they produce the signed root. */
export function treeForSignedRoot(entryHashesHex: string[], listRoot: Uint8Array): SanctionsTree {
  const t = new SanctionsTree(entryHashesHex);
  if (Buffer.compare(Buffer.from(t.rootBytes), Buffer.from(listRoot)) !== 0) throw new Error('sanctions entries do not produce the signed list_root');
  return t;
}
export const readEntries = (text: string): string[] => text.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);

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

/**
 * Journey E6: Travel Rule transfers from the pilot-gateway, sealed by the agent daemon on the
 * institution's own TravelRuleGate (deploy-v9.ts --institution). Pure part, no network.
 *
 * Queue item (public fields only; the agent's queue file never holds personal data):
 *   kind "travel_rule_transfer": institution, transfer_id (hex32), policy_hash (hex32, not zero),
 *     sanctions_list (the provider-signed payload, docs/TRAVEL-RULE-DISCLOSURE.md), witness_ref
 *   kind "travel_rule_release":  institution, transfer_id
 * Private witness: <MIDNIGHT_TRANSFER_WITNESS_DIR>/<transfer_id>.json (tmpfs; regular file, no access
 * for "other"), TransferWitness format of scripts/lib/travel-rule-v10.ts: originator / beneficiary
 * { name_hash, account_hash, doc_hash, vasp_id, salt } (hashes and salts, never raw values),
 * amount_cents. The beneficiary vasp_id is the counterparty's passportId as issued
 * on PsavPassport (the same 32 bytes, not a hash of it). The agent deletes the file right after the
 * proof attempt, success or failure; on retry the gateway writes it again.
 * Sanctions snapshot (public): <MIDNIGHT_SANCTIONS_DIR>/<list_root>.txt, one entry hash per line, the
 * provider's published list behind the signed root. The agent rebuilds the indexed tree from it (checked
 * against the signed list_root) to prove each party's identifiers in-circuit (witness sanctions_path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkInstitutionId } from './institutions.js';
import { parseTransferWitness, type PartyBytes } from './travel-rule-v10.js';
import { fromPayload, readEntries, treeForSignedRoot, type SanctionsListWitness, type SanctionsTree } from './sanctions-list.js';

const HEX32 = /^[0-9a-f]{64}$/;
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

export type TransferItem = { institution: string; transferId: Uint8Array; transferIdHex: string; policyHash: Uint8Array; list: SanctionsListWitness; witnessRef: string };
export type ReleaseItem = { institution: string; transferId: Uint8Array; transferIdHex: string };

function common(j: any) {
  const institution = checkInstitutionId(String(j?.institution ?? ''));
  const t = String(j?.transfer_id ?? '').toLowerCase();
  if (!HEX32.test(t)) throw new Error('transfer_id must be 32 bytes hex');
  return { institution, transferId: bytes(t), transferIdHex: t };
}

export function parseTransferItem(j: any): TransferItem {
  const c = common(j);
  const p = String(j?.policy_hash ?? '').toLowerCase();
  if (!HEX32.test(p) || /^0+$/.test(p)) throw new Error('policy_hash must be 32 bytes hex, not zero');
  if (j?.witness_ref !== `${c.transferIdHex}.json`) throw new Error(`witness_ref must be "<transfer_id>.json" (${c.transferIdHex}.json)`);
  if (!j?.sanctions_list) throw new Error('sanctions_list (signed payload) is required');
  return { ...c, policyHash: bytes(p), list: fromPayload(j.sanctions_list), witnessRef: j.witness_ref };
}

export const parseReleaseItem = (j: any): ReleaseItem => common(j);

export function witnessPath(dir: string, item: TransferItem): string {
  if (!dir || !path.isAbsolute(dir)) throw new Error('MIDNIGHT_TRANSFER_WITNESS_DIR must be an absolute path');
  return path.join(dir, item.witnessRef);
}

/** The private witness: regular file (not a link), no access for "other"; salts checked like the circuit. */
export function readWitnessFile(file: string): { o: PartyBytes; b: PartyBytes; amount: bigint } {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${file} must be a regular file (not a link)`);
  if ((st.mode & 0o007) !== 0) throw new Error(`${file} holds private transfer data: no access for "other" (0640 or 0600)`);
  const w = parseTransferWitness(JSON.parse(fs.readFileSync(file, 'utf8')));
  const zero = (u: Uint8Array) => u.every((x) => x === 0);
  if (zero(w.o.salt) || zero(w.b.salt)) throw new Error('party salt must not be zero');
  if (Buffer.from(w.o.salt).equals(Buffer.from(w.b.salt))) throw new Error('originator and beneficiary salts must differ');
  return w;
}

const trees = new Map<string, SanctionsTree>();
/** The indexed tree behind a signed list, from <dir>/<list_root>.txt (cached per root; refused if the root differs). */
export function sanctionsTreeFor(dir: string, list: SanctionsListWitness): SanctionsTree {
  if (!dir || !path.isAbsolute(dir)) throw new Error('MIDNIGHT_SANCTIONS_DIR must be an absolute path');
  const root = Buffer.from(list.list_root).toString('hex');
  const hit = trees.get(root);
  if (hit) return hit;
  const file = path.join(dir, `${root}.txt`);
  if (!fs.existsSync(file)) throw new Error(`sanctions snapshot ${root}.txt not found in MIDNIGHT_SANCTIONS_DIR`);
  const t = treeForSignedRoot(readEntries(fs.readFileSync(file, 'utf8')), list.list_root);
  trees.set(root, t);
  return t;
}

/** Deletes the witness file; never throws (the caller logs a failure to delete). */
export function dropWitness(file: string): string | null {
  try { fs.rmSync(file, { force: true }); return null; } catch (e: any) { return String(e?.message ?? e); }
}

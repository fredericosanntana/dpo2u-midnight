/**
 * Disclosure governance for the Travel Rule gate.
 *
 * Issues scoped, expiring access credentials ("disclosure keys") to supervisors with a stated
 * legal basis; supports revocation; and writes EVERY decision (granted or denied) to an
 * append-only, hash-chained log. Pure Node (node:crypto), no network, no on-chain write.
 *
 * Field scope uses the same bitmask as compact/TravelRuleGate.compact:
 *   1 name, 2 account, 4 document, 8 vasp  (per party: originator / beneficiary)
 *
 * On-chain link (TravelRuleGate v10): the grant's purpose_hash (purposeHash below: sha256 of the
 * canonical grant terms, legal basis included) is what the owner passes to grantDisclosure, so the
 * on-chain grant_purpose commits to this exact credential. The on-chain grant only becomes active
 * after approveDisclosure by the second key; issue the off-chain credential after that approval.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ExceptionItem, type ExceptionSource, exceptionId, slaHours, reasonOf, checkDecision, isOverdue } from './exceptions.js';
import { view, type Role, type GateSnapshot, type Period } from './roles.js';

export const FIELD_BITS = { name: 1, account: 2, document: 4, vasp: 8 } as const;
export type Field = keyof typeof FIELD_BITS;
export type Party = 'originator' | 'beneficiary';

export const scopeMask = (fields: Field[]) => fields.reduce((m, f) => m | FIELD_BITS[f], 0);
export const maskFields = (m: number): Field[] => (Object.keys(FIELD_BITS) as Field[]).filter((f) => m & FIELD_BITS[f]);

export interface Claims {
  grant_id: string;
  supervisor: string;          // e.g. "BCB" (fictional demo identity)
  legal_basis: string;         // free text citing the instrument, required
  transfer_ids: string[];      // transfers this credential can touch
  parties: Party[];            // which party records
  scope: number;               // bitmask of fields
  issued_at: number;           // unix seconds
  expires_at: number;          // unix seconds
}

export interface LogEntry {
  seq: number;
  ts: number;
  // EXCEPTION_*: grant_id carries the exception id, supervisor the actor (owner / decider).
  // ROLE_VIEW: grant_id carries the role, supervisor the actor who pulled the view.
  event: 'ISSUE' | 'REVOKE' | 'ACCESS_GRANTED' | 'ACCESS_DENIED' | 'EXCEPTION_OPEN' | 'EXCEPTION_DECIDE' | 'ROLE_VIEW';
  grant_id: string;
  supervisor: string;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

/**
 * Where the shielded records live (the VASP vault). Returns the opening of ONE field: its value and
 * that field's blinding (TravelRuleGate.field_blinding(party salt, label)), never the party salt,
 * which would let the reader derive the blindings of the fields outside the grant's scope.
 * The supervisor checks it with TravelRuleGate.field_commit_blinded(value, blinding).
 */
export interface FieldOpening { value: string; blinding: string }
export interface DataSource {
  open(transferId: string, party: Party, field: Field): FieldOpening | undefined;
}

export type AccessResult =
  | { ok: true; fields: Record<string, FieldOpening> }
  | { ok: false; reason: string };

const GENESIS = '0'.repeat(64);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Stable JSON: keys sorted recursively, so the hash does not depend on insertion order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** sha256 of the canonical grant terms (no issued_at): the purpose_hash given to TravelRuleGate.grantDisclosure. */
export function purposeHash(c: Pick<Claims, 'grant_id' | 'supervisor' | 'legal_basis' | 'transfer_ids' | 'parties' | 'scope' | 'expires_at'>): string {
  const { grant_id, supervisor, legal_basis, transfer_ids, parties, scope, expires_at } = c;
  return sha256(canonical({ grant_id, supervisor, legal_basis, transfer_ids, parties, scope, expires_at }));
}

export class DisclosureGovernance {
  private revoked = new Set<string>();
  private issued = new Map<string, Claims>();
  private excs = new Map<string, ExceptionItem>();
  private entries: LogEntry[] = [];

  /**
   * @param masterKey 32-byte issuer key. Provide it from a 0600 file (see loadKey); never log it.
   * @param logPath   JSONL file, append-only.
   * @param now       injectable clock (unix seconds) for tests/demo.
   */
  constructor(private masterKey: Buffer, private logPath: string, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (masterKey.length !== 32) throw new Error('masterKey must be 32 bytes');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath)) {
      // Fail closed: a tampered log (e.g. a REVOKE edited away) must not rebuild revoked/issued.
      const v = DisclosureGovernance.verifyLog(logPath);
      if (!v.ok) throw new Error(`disclosure log failed verification: ${v.error}`);
      this.entries = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      for (const e of this.entries) {
        if (e.event === 'REVOKE') this.revoked.add(e.grant_id);
        if (e.event === 'ISSUE') this.issued.set(e.grant_id, e.detail.claims as Claims);
        if (e.event === 'EXCEPTION_OPEN') this.excs.set(e.grant_id, { ...(e.detail.item as ExceptionItem) });
        if (e.event === 'EXCEPTION_DECIDE') {
          const it = this.excs.get(e.grant_id);
          if (it) Object.assign(it, { status: 'decided', decision: e.detail.decision, decided_by: e.supervisor, decided_at: e.ts, justification: e.detail.justification });
        }
      }
    }
  }

  static loadKey(file: string): Buffer {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) throw new Error(`key file ${file} must be mode 600`);
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  }

  /** Per-grant disclosure key (HKDF), the key under which the off-chain package is encrypted. */
  disclosureKey(c: Claims): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.from(c.grant_id), Buffer.from('dpo2u/disclosure/' + c.scope + '/' + c.expires_at), 32));
  }

  private append(event: LogEntry['event'], grant_id: string, supervisor: string, detail: Record<string, unknown>): LogEntry {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
    const base = { seq: this.entries.length, ts: this.now(), event, grant_id, supervisor, detail, prev_hash: prev };
    const entry: LogEntry = { ...base, hash: sha256(prev + canonical(base)) };
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    this.entries.push(entry);
    return entry;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.masterKey).update(payload).digest('base64url');
  }

  issue(p: Omit<Claims, 'grant_id' | 'issued_at'> & { grant_id?: string }): string {
    if (!p.legal_basis?.trim()) throw new Error('legal_basis is required');
    if (!p.scope) throw new Error('scope must not be empty');
    if (!p.transfer_ids.length || !p.parties.length) throw new Error('transfer_ids and parties are required');
    const issued_at = this.now();
    if (p.expires_at <= issued_at) throw new Error('expires_at must be in the future');
    const claims: Claims = { ...p, grant_id: p.grant_id ?? 'g-' + randomBytes(6).toString('hex'), issued_at };
    if (this.issued.has(claims.grant_id)) throw new Error('grant_id already used');
    this.issued.set(claims.grant_id, claims);
    this.append('ISSUE', claims.grant_id, claims.supervisor, { claims, scope_fields: maskFields(claims.scope), purpose_hash: purposeHash(claims) });
    const payload = b64u(canonical(claims));
    return payload + '.' + this.sign(payload);
  }

  revoke(grantId: string, reason: string): void {
    const c = this.issued.get(grantId);
    if (!c) throw new Error('unknown grant');
    this.revoked.add(grantId);
    this.append('REVOKE', grantId, c.supervisor, { reason });
  }

  /** Verifies a token's signature; returns claims or undefined. Does not log. */
  private parse(token: string): Claims | undefined {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return undefined;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return undefined; }
  }

  access(token: string, req: { transfer_id: string; party: Party; fields: Field[] }, src: DataSource): AccessResult {
    const claims = this.parse(token);
    if (!claims) {
      this.append('ACCESS_DENIED', 'unknown', 'unknown', { reason: 'invalid_credential', request: req });
      return { ok: false, reason: 'invalid_credential' };
    }
    const deny = (reason: string): AccessResult => {
      this.append('ACCESS_DENIED', claims.grant_id, claims.supervisor, { reason, request: req });
      return { ok: false, reason };
    };
    if (this.revoked.has(claims.grant_id)) return deny('revoked');
    if (this.now() >= claims.expires_at) return deny('expired');
    if (!claims.transfer_ids.includes(req.transfer_id)) return deny('transfer_out_of_scope');
    if (!claims.parties.includes(req.party)) return deny('party_out_of_scope');
    if (!req.fields.length) return deny('no_fields_requested');
    const outside = req.fields.filter((f) => !(claims.scope & FIELD_BITS[f]));
    if (outside.length) return deny('field_out_of_scope:' + outside.join(','));
    const out: Record<string, FieldOpening> = {};
    for (const f of req.fields) {
      const o = src.open(req.transfer_id, req.party, f);
      if (!o) return deny('not_found');
      if (typeof o.blinding !== 'string' || !o.blinding) return deny('opening_without_blinding');
      out[f] = { value: o.value, blinding: o.blinding }; // only these two keys leave the vault
    }
    this.append('ACCESS_GRANTED', claims.grant_id, claims.supervisor, { request: req, legal_basis: claims.legal_basis });
    return { ok: true, fields: out };
  }

  // ── exception queue (src/disclosure/exceptions.ts) ──
  /** Opens an item for a FAIL / refused attestation. Idempotent: an existing item is returned unchanged. */
  openException(p: { source: ExceptionSource; ref: string; reason_code: number; reason_text?: string; policy_hash?: string; owner: string; due_hours?: number }): ExceptionItem {
    if (!p.ref?.trim()) throw new Error('ref is required');
    if (!p.owner?.trim()) throw new Error('owner is required');
    const id = exceptionId(p.source, p.ref);
    const existing = this.excs.get(id);
    if (existing) return existing;
    const opened_at = this.now();
    const item: ExceptionItem = {
      id, source: p.source, ref: p.ref, reason_code: p.reason_code, reason: reasonOf(p.source, p.reason_code, p.reason_text),
      ...(p.policy_hash ? { policy_hash: p.policy_hash } : {}), owner: p.owner,
      opened_at, due_at: opened_at + 3600 * (p.due_hours ?? slaHours(p.source, p.reason_code)), status: 'open',
    };
    this.excs.set(id, item);
    this.append('EXCEPTION_OPEN', id, p.owner, { item });
    return item;
  }

  decideException(id: string, d: { decision: string; by: string; justification: string }): ExceptionItem {
    const item = this.excs.get(id);
    checkDecision(item, d);
    const now = this.now();
    this.append('EXCEPTION_DECIDE', id, d.by, { decision: d.decision, justification: d.justification, overdue_when_decided: now >= item!.due_at });
    Object.assign(item!, { status: 'decided', decision: d.decision, decided_by: d.by, decided_at: now, justification: d.justification });
    return item!;
  }

  exceptions(filter: { open?: boolean; overdue?: boolean } = {}): ExceptionItem[] {
    const now = this.now();
    return [...this.excs.values()]
      .filter((e) => (!filter.open || e.status === 'open') && (!filter.overdue || isOverdue(e, now)))
      .map((e) => ({ ...e }));
  }

  /** Role view of a gate snapshot (src/disclosure/roles.ts), logged with what was returned (counts only). */
  roleView(role: Role, actor: string, snapshot: GateSnapshot, opts: { period?: Period } = {}): Record<string, unknown> {
    if (!actor?.trim()) throw new Error('actor is required');
    const v = view(role, snapshot, opts);
    const size = Array.isArray(v.failed) ? v.failed.length : Array.isArray(v.transfers) ? v.transfers.length : Array.isArray(v.buckets) ? v.buckets.length : 0;
    this.append('ROLE_VIEW', role, actor, { gate: snapshot.gate, network: snapshot.network, rows: size, ...(opts.period ? { period: opts.period } : {}) });
    return v;
  }

  log(): readonly LogEntry[] { return this.entries; }
  head(): string { return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS; }

  /** Re-reads the file from disk and checks the whole chain. */
  static verifyLog(logPath: string): { ok: boolean; entries: number; head: string; error?: string } {
    const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const e: LogEntry = JSON.parse(lines[i]);
      const { hash, ...base } = e;
      if (e.seq !== i) return { ok: false, entries: lines.length, head: prev, error: `seq mismatch at ${i}` };
      if (e.prev_hash !== prev) return { ok: false, entries: lines.length, head: prev, error: `broken link at ${i}` };
      if (sha256(prev + canonical(base)) !== hash) return { ok: false, entries: lines.length, head: prev, error: `hash mismatch at ${i}` };
      prev = hash;
    }
    return { ok: true, entries: lines.length, head: prev };
  }
}

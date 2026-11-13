/**
 * Exception queue: every Travel Rule FAIL (by reason code) and every refused attestation becomes an
 * item with an owner, a due date, a decision and a justification. Items live in the disclosure
 * log (hash-chained, append-only): EXCEPTION_OPEN and EXCEPTION_DECIDE entries, rebuilt on load.
 * This file holds the rules; DisclosureGovernance writes the entries.
 */
import { createHash } from 'node:crypto';
import { REASONS, type TransferRecord } from './roles.js';

export type ExceptionSource = 'travel_rule_fail' | 'attestation_refused';
export const DECISIONS = ['uphold', 'remediate', 'escalate', 'false_positive'] as const;
export type Decision = (typeof DECISIONS)[number];
// uphold: the block/refusal stands. remediate: data or policy fixed, re-evaluate.
// escalate: to the CCO / supervisor (sanctions hits always end here or in uphold).
// false_positive: the rule fired wrongly; needs a policy change record.

export type ExceptionItem = {
  id: string;
  source: ExceptionSource;
  ref: string;                 // transfer_id (hex) or attestation reference
  reason_code: number;
  reason: string;
  policy_hash?: string;
  owner: string;
  opened_at: number;
  due_at: number;
  status: 'open' | 'decided';
  decision?: Decision;
  decided_by?: string;
  decided_at?: number;
  justification?: string;
};

/** Hours to decide, by reason. Sanctions hits are the shortest. Attestation refusals: 72h. */
export const SLA_HOURS: Record<string, number> = { 'travel_rule_fail:1': 72, 'travel_rule_fail:2': 72, 'travel_rule_fail:3': 48, 'travel_rule_fail:4': 24, attestation_refused: 72 };
export const slaHours = (source: ExceptionSource, code: number) => SLA_HOURS[source === 'travel_rule_fail' ? `${source}:${code}` : source] ?? 72;

/** Deterministic id: the same FAIL never opens two items. */
export const exceptionId = (source: ExceptionSource, ref: string) => 'exc-' + createHash('sha256').update(`${source}|${ref}`).digest('hex').slice(0, 16);

export function reasonOf(source: ExceptionSource, code: number, text?: string): string {
  if (source === 'travel_rule_fail') return REASONS[code] ?? `unknown(${code})`;
  return text?.trim() || 'attestation refused';
}

export function checkDecision(item: ExceptionItem | undefined, d: { decision: string; by: string; justification: string }): asserts d is { decision: Decision; by: string; justification: string } {
  if (!item) throw new Error('unknown exception');
  if (item.status === 'decided') throw new Error('exception already decided');
  if (!(DECISIONS as readonly string[]).includes(d.decision)) throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
  if (!d.by?.trim()) throw new Error('decided_by is required');
  if ((d.justification ?? '').trim().length < 20) throw new Error('justification is required (at least 20 characters)');
  if (item.source === 'travel_rule_fail' && item.reason_code === 4 && d.decision === 'false_positive' && !/policy|screening|list/i.test(d.justification)) {
    throw new Error('a sanctions hit closed as false_positive must cite the screening/list/policy evidence in the justification');
  }
}

export const isOverdue = (e: ExceptionItem, now: number) => e.status === 'open' && now >= e.due_at;

/** FAIL transfers of a gate snapshot as exception inputs. */
export function failsOf(transfers: TransferRecord[]) {
  return transfers.filter((t) => t.status === 2).map((t) => ({ source: 'travel_rule_fail' as const, ref: t.transfer_id, reason_code: t.fail_reason, policy_hash: t.policy_hash }));
}
